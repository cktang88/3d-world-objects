import * as THREE from 'three';
import { pbr, type PbrMaps } from './pbr';

/**
 * sand3d writes each material as a flat UsdPreviewSurface, but names it after its kind:
 * "oak__6e4a32", "brushed_steel__9aa0a6", "fabric__…". We turn the kind back into a physically
 * based material (docs/research/materials.md):
 *
 * - a MeshPhysicalMaterial with the kind's real optics: measured metal F0 colours, anisotropic
 *   highlights on brushed metal, clearcoat on glaze / lacquer / car paint, sheen on cloth;
 * - CC0 PBR texture sets (Poly Haven, ambientCG) tinted by sand3d's colour: albedo variation,
 *   roughness relative to sand3d's own value, and a real normal map. Without UVs they are
 *   projected triplanar (whiteout-blended normals); rebuilt GLBs carry metric UVs (1 unit = 1 m);
 * - texture bombing (two randomly offset lookups per projection) on small-tile kinds to hide repeats;
 * - a procedural micro-detail bump on top, faded out with distance;
 * - optional per-vertex bake from scripts/rebuild.py --bake (COLOR_0: R = ambient occlusion,
 *   G = convexity for edge wear): occludes indirect light, wears paint and finish off edges.
 */

type Proc = 'grain' | 'brushed' | 'smudge' | 'peel' | 'micro' | 'weave' | 'leather' | 'marble' | 'concrete' | 'rubber';

interface KindSpec {
  /** procedural pattern: colour variation until the photo set loads, then micro-detail bump */
  tex: Proc;
  tile: number; // metres per procedural repeat
  strength: number; // procedural colour variation
  bump: number; // procedural bump (before photo load)
  rough: number; // procedural roughness variation
  dark: number;
  /** after the photo set loads: how much albedo / roughness / normal it contributes, and the micro bump */
  diff: number;
  arm: number;
  nor: number;
  detail: number;
  /** clamp sand3d's roughness into what the real material can be */
  r: [number, number];
  /** metals: linear base colour (F0) from physicallybased.info, and how much of sand3d's colour to keep */
  metal?: [number, number, number];
  tint?: number;
  aniso?: number;
  clearcoat?: number;
  clearcoatRough?: number;
  sheen?: number;
  sheenRough?: number;
  spec?: number;
  ior?: number;
  /** texture bombing against visible repeats */
  antiTile?: boolean;
  /** edge wear with a baked convexity mask: 0 none */
  wear?: number;
  /** wood: lacquer when sand3d asked for a glossy finish */
  varnish?: boolean;
}

const STAINLESS: [number, number, number] = [0.669, 0.639, 0.598];
const KINDS: Record<string, KindSpec> = {
  oak: { tex: 'grain', tile: 0.45, strength: 0.55, bump: 0.9, rough: 0.2, dark: 0.55, diff: 0.95, arm: 0.6, nor: 0.8, detail: 0, r: [0.3, 0.85], varnish: true, wear: 0.5 },
  walnut: { tex: 'grain', tile: 0.4, strength: 0.6, bump: 0.9, rough: 0.2, dark: 0.45, diff: 0.95, arm: 0.6, nor: 0.8, detail: 0, r: [0.3, 0.85], varnish: true, wear: 0.5 },
  pine: { tex: 'grain', tile: 0.5, strength: 0.45, bump: 0.7, rough: 0.2, dark: 0.62, diff: 0.95, arm: 0.6, nor: 0.8, detail: 0, r: [0.3, 0.85], varnish: true, wear: 0.5 },
  birch: { tex: 'grain', tile: 0.5, strength: 0.3, bump: 0.5, rough: 0.15, dark: 0.75, diff: 0.9, arm: 0.6, nor: 0.7, detail: 0, r: [0.3, 0.85], varnish: true, wear: 0.5 },
  steel: { tex: 'brushed', tile: 0.25, strength: 0.14, bump: 0.25, rough: 0.3, dark: 0.75, diff: 0.3, arm: 1, nor: 0.4, detail: 0, r: [0.18, 0.55], metal: STAINLESS, tint: 0.35, aniso: 0.35, wear: 0.4 },
  brushed_steel: { tex: 'brushed', tile: 0.2, strength: 0.18, bump: 0.3, rough: 0.35, dark: 0.7, diff: 0.3, arm: 1, nor: 0.5, detail: 0, r: [0.22, 0.5], metal: STAINLESS, tint: 0.3, aniso: 0.8, wear: 0.3 },
  aluminium: { tex: 'brushed', tile: 0.2, strength: 0.12, bump: 0.2, rough: 0.3, dark: 0.8, diff: 0.25, arm: 1, nor: 0.4, detail: 0, r: [0.2, 0.5], metal: [0.916, 0.923, 0.924], tint: 0.35, aniso: 0.45, wear: 0.3 },
  chrome: { tex: 'smudge', tile: 0.6, strength: 0.04, bump: 0.05, rough: 0.12, dark: 0.85, diff: 0.1, arm: 1, nor: 0.1, detail: 0, r: [0.03, 0.14], metal: [0.654, 0.685, 0.701], tint: 0.15 },
  brass: { tex: 'smudge', tile: 0.4, strength: 0.18, bump: 0.1, rough: 0.25, dark: 0.7, diff: 0.35, arm: 1, nor: 0.2, detail: 0, r: [0.12, 0.45], metal: [0.91, 0.778, 0.423], tint: 0.3, wear: 0.4 },
  copper: { tex: 'smudge', tile: 0.4, strength: 0.22, bump: 0.1, rough: 0.25, dark: 0.65, diff: 0.4, arm: 1, nor: 0.2, detail: 0, r: [0.12, 0.45], metal: [0.932, 0.623, 0.522], tint: 0.3, wear: 0.4 },
  painted_metal: { tex: 'peel', tile: 0.12, strength: 0.06, bump: 0.25, rough: 0.12, dark: 0.85, diff: 0.12, arm: 0.8, nor: 0.35, detail: 0.15, r: [0.18, 0.7], clearcoat: 0.35, clearcoatRough: 0.12, wear: 1 },
  plastic: { tex: 'micro', tile: 0.06, strength: 0.05, bump: 0.15, rough: 0.12, dark: 0.85, diff: 0.12, arm: 0.8, nor: 0.35, detail: 0.3, r: [0.28, 0.75], ior: 1.5, wear: 0.25 },
  glossy_plastic: { tex: 'micro', tile: 0.08, strength: 0.03, bump: 0.06, rough: 0.06, dark: 0.9, diff: 0.1, arm: 0.6, nor: 0.15, detail: 0.1, r: [0.06, 0.3], ior: 1.5, clearcoat: 0.4, clearcoatRough: 0.06 },
  rubber: { tex: 'rubber', tile: 0.04, strength: 0.12, bump: 0.4, rough: 0.1, dark: 0.7, diff: 0.35, arm: 0.6, nor: 0.7, detail: 0.3, r: [0.7, 0.95], spec: 0.5, antiTile: true },
  fabric: { tex: 'weave', tile: 0.025, strength: 0.3, bump: 0.7, rough: 0.05, dark: 0.6, diff: 0.9, arm: 0.6, nor: 1.0, detail: 0, r: [0.8, 1], sheen: 0.6, sheenRough: 0.75, spec: 0.35, antiTile: true },
  velvet: { tex: 'weave', tile: 0.012, strength: 0.25, bump: 0.4, rough: 0.05, dark: 0.55, diff: 0.9, arm: 0.5, nor: 0.7, detail: 0, r: [0.85, 1], sheen: 1, sheenRough: 0.35, spec: 0.3, antiTile: true },
  leather: { tex: 'leather', tile: 0.05, strength: 0.25, bump: 0.8, rough: 0.2, dark: 0.6, diff: 0.75, arm: 0.8, nor: 1.0, detail: 0, r: [0.35, 0.75], clearcoat: 0.15, clearcoatRough: 0.35, antiTile: true, wear: 0.5 },
  marble: { tex: 'marble', tile: 0.7, strength: 0.6, bump: 0.05, rough: 0.1, dark: 0.45, diff: 0.95, arm: 0.5, nor: 0.3, detail: 0, r: [0.08, 0.5], clearcoat: 0.5, clearcoatRough: 0.05 },
  concrete: { tex: 'concrete', tile: 0.5, strength: 0.35, bump: 0.7, rough: 0.15, dark: 0.6, diff: 0.9, arm: 0.8, nor: 1.0, detail: 0, r: [0.7, 1], antiTile: true },
  ceramic: { tex: 'micro', tile: 0.15, strength: 0.03, bump: 0.04, rough: 0.05, dark: 0.9, diff: 0.15, arm: 0.6, nor: 0.15, detail: 0, r: [0.2, 0.8], clearcoat: 1, clearcoatRough: 0.04 },
};

// ---- tileable procedural textures -------------------------------------------

const S = 512;
function hash(x: number, y: number, s: number) {
  let h = (x * 374761393 + y * 668265263 + s * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
/** periodic value noise, period p lattice cells across the texture */
function vnoise(u: number, v: number, p: number, seed: number) {
  const x = u * p, y = v * p;
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
  const w = (a: number) => ((a % p) + p) % p;
  const a = hash(w(xi), w(yi), seed), b = hash(w(xi + 1), w(yi), seed);
  const c = hash(w(xi), w(yi + 1), seed), d = hash(w(xi + 1), w(yi + 1), seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
function fbm(u: number, v: number, p: number, oct: number, seed: number) {
  let s = 0, amp = 0.5, tot = 0;
  for (let o = 0; o < oct; o++) {
    s += vnoise(u, v, p << o, seed + o) * amp;
    tot += amp;
    amp *= 0.5;
  }
  return s / tot;
}

function makeTex(kind: Proc): THREE.DataTexture {
  const data = new Uint8Array(S * S * 4);
  for (let j = 0; j < S; j++)
    for (let i = 0; i < S; i++) {
      const u = i / S, v = j / S;
      let h = 0.5;
      switch (kind) {
        case 'grain': {
          const warp = fbm(u, v, 4, 4, 1) * 6;
          const ring = (u * 9 + warp) % 1;
          const fine = fbm(u * 1, v, 64, 2, 2);
          h = 0.55 + 0.35 * Math.pow(Math.abs(Math.sin(ring * Math.PI)), 6) * -1 + 0.25 * fine + 0.15 * vnoise(u, v, 8, 3);
          break;
        }
        case 'brushed':
          h = 0.5 + 0.6 * (hash(i, Math.floor(j / 64), 7) - 0.5) * 0.4 + 0.35 * (vnoise(u, 0.5, 512, 8) - 0.5) + 0.2 * (fbm(u, v, 4, 3, 5) - 0.5);
          break;
        case 'smudge':
          h = fbm(u, v, 4, 5, 11);
          break;
        case 'peel':
          h = 0.5 + 0.5 * (fbm(u, v, 32, 3, 13) - 0.5) * 2;
          break;
        case 'micro':
          h = 0.5 + 0.8 * (fbm(u, v, 64, 3, 17) - 0.5);
          break;
        case 'rubber':
          h = 0.4 + 0.6 * fbm(u, v, 64, 3, 19) + (hash(i, j, 20) > 0.995 ? -0.3 : 0);
          break;
        case 'weave': {
          const n = 32;
          const cu = (u * n) % 1, cv = (v * n) % 1;
          const over = (Math.floor(u * n) + Math.floor(v * n)) % 2 === 0;
          const thread = over ? Math.sin(cu * Math.PI) : Math.sin(cv * Math.PI);
          h = 0.25 + 0.6 * thread + 0.15 * vnoise(u, v, 128, 23);
          break;
        }
        case 'leather': {
          const n = 24;
          const x = u * n, y = v * n;
          let d1 = 9, d2 = 9;
          for (let oy = -1; oy <= 1; oy++)
            for (let ox = -1; ox <= 1; ox++) {
              const cx = Math.floor(x) + ox, cy = Math.floor(y) + oy;
              const px = cx + hash(((cx % n) + n) % n, ((cy % n) + n) % n, 29);
              const py = cy + hash(((cx % n) + n) % n, ((cy % n) + n) % n, 31);
              const d = Math.hypot(px - x, py - y);
              if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
            }
          h = Math.min(1, (d2 - d1) * 2.2) * 0.8 + 0.2 * vnoise(u, v, 64, 33);
          break;
        }
        case 'marble': {
          const t = fbm(u, v, 4, 6, 37) * 7;
          h = 1 - Math.pow(Math.abs(Math.sin((u + v) * Math.PI * 2 + t)), 0.25) * 0.85;
          h = 1 - h * 0.9;
          break;
        }
        case 'concrete':
          h = 0.35 + 0.5 * fbm(u, v, 16, 5, 41) + (hash(i, j, 43) > 0.993 ? -0.35 : 0);
          break;
      }
      const b = Math.max(0, Math.min(255, Math.round(h * 255)));
      const k = (j * S + i) * 4;
      data[k] = data[k + 1] = data[k + 2] = b;
      data[k + 3] = 255;
    }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}
const texCache = new Map<string, THREE.DataTexture>();
function tex(kind: Proc) {
  let t = texCache.get(kind);
  if (!t) {
    t = makeTex(kind);
    texCache.set(kind, t);
  }
  return t;
}

// ---- shader injection ---------------------------------------------------------

const VERT_DECL = `
varying vec3 vTriPos;
varying vec3 vTriNrm;
varying vec3 vTriAx, vTriAy, vTriAz;
#ifdef TRI_UV
varying vec2 vTriUv;
#endif
#ifdef TRI_BAKE
attribute vec3 color;
varying vec3 vTriBake;
#endif
`;
const VERT_BODY = `
vTriPos = position;
vTriNrm = normal;
{
  mat3 triMv = mat3(modelViewMatrix);
#ifdef USE_INSTANCING
  triMv = triMv * mat3(instanceMatrix);
#endif
  vTriAx = triMv[0]; vTriAy = triMv[1]; vTriAz = triMv[2];
}
#ifdef TRI_UV
vTriUv = uv;
#endif
#ifdef TRI_BAKE
vTriBake = color;
#endif
`;

const FRAG_DECL = `
varying vec3 vTriPos;
varying vec3 vTriNrm;
varying vec3 vTriAx, vTriAy, vTriAz;
#ifdef TRI_UV
varying vec2 vTriUv;
#endif
#ifdef TRI_BAKE
varying vec3 vTriBake;
#endif
uniform sampler2D uTriDiff;   // photo albedo (white until loaded)
uniform sampler2D uTriNor;    // OpenGL normal map (flat until loaded)
uniform sampler2D uTriArm;    // AO / roughness / metalness
uniform sampler2D uTriDetail; // procedural height
uniform vec3 uTriMean;
uniform float uTriRoughMean;
uniform float uTriScale, uProcScale, uTriStrength, uTriBump, uTriRough, uTriDark;
uniform float uDiffMix, uArmMix, uNorMix, uWear, uWearAll, uBakeAo, uDust, uDbg;

float triHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float triNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(triHash(i), triHash(i + vec2(1.0, 0.0)), f.x), mix(triHash(i + vec2(0.0, 1.0)), triHash(i + vec2(1.0, 1.0)), f.x), f.y);
}

// Texture bombing (Inigo Quilez, "texture repetition", technique 3): two lookups at random
// offsets chosen by a low-frequency noise, blended; every map uses the same offsets.
struct TriAT { vec2 a; vec2 b; float f; vec2 dx; vec2 dy; };
TriAT triAT(vec2 uv) {
  TriAT t;
  float l = triNoise(uv * 0.6) * 8.0;
  float i = floor(l);
  t.a = sin(vec2(3.0, 7.0) * i);
  t.b = sin(vec2(3.0, 7.0) * (i + 1.0));
  t.f = smoothstep(0.25, 0.75, fract(l));
  t.dx = dFdx(uv); t.dy = dFdy(uv);
  return t;
}
vec4 triS(sampler2D s, vec2 uv, TriAT t) {
#ifdef TRI_ANTITILE
  return mix(textureGrad(s, uv + t.a, t.dx, t.dy), textureGrad(s, uv + t.b, t.dx, t.dy), t.f);
#else
  return texture2D(s, uv);
#endif
}

vec3 triPerturb(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDir) {
  vec3 vSigmaX = dFdx(surf_pos.xyz);
  vec3 vSigmaY = dFdy(surf_pos.xyz);
  vec3 R1 = cross(vSigmaY, surf_norm);
  vec3 R2 = cross(surf_norm, vSigmaX);
  float fDet = dot(vSigmaX, R1) * faceDir;
  vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
  return normalize(abs(fDet) * surf_norm - vGrad);
}
mat3 triFrame(vec3 eye_pos, vec3 surf_norm, vec2 uv) {
  vec3 q0 = dFdx(eye_pos.xyz);
  vec3 q1 = dFdy(eye_pos.xyz);
  vec2 st0 = dFdx(uv.st);
  vec2 st1 = dFdy(uv.st);
  vec3 q1perp = cross(q1, surf_norm);
  vec3 q0perp = cross(surf_norm, q0);
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max(dot(T, T), dot(B, B));
  float scale = (det == 0.0) ? 0.0 : inversesqrt(det);
  return mat3(T * scale, B * scale, surf_norm);
}
vec3 triToView(vec3 v) { return normalize(vTriAx * v.x + vTriAy * v.y + vTriAz * v.z); }
`;

/** sample every map once (in color_fragment), keep the results for the later chunks */
const SAMPLE = `
float triFace = gl_FrontFacing ? 1.0 : -1.0;
vec3 triN = normalize(vTriNrm) * triFace;
vec4 triDiff, triArm; vec3 triNorO; float triH;
#ifdef TRI_UV
  vec2 triUv = vTriUv * uTriScale;
  TriAT triA = triAT(triUv);
  triDiff = triS(uTriDiff, triUv, triA);
  triArm = triS(uTriArm, triUv, triA);
  triNorO = triS(uTriNor, triUv, triA).xyz * 2.0 - 1.0;
  triH = texture2D(uTriDetail, vTriUv * uProcScale).r;
  vec3 triBrush = vec3(0.0);
#else
  vec3 triW = pow(max(abs(triN) - 0.2, 0.0), vec3(3.0));
  triW /= max(triW.x + triW.y + triW.z, 1e-5);
  vec3 triSg = vec3(triN.x < 0.0 ? -1.0 : 1.0, triN.y < 0.0 ? -1.0 : 1.0, triN.z < 0.0 ? -1.0 : 1.0);
  vec3 triP = vTriPos * uTriScale;
  // Ben Golus' triplanar: mirror u on negative faces so textures do not appear flipped
  vec2 uvX = vec2(triP.z * triSg.x, triP.y);
  vec2 uvY = vec2(triP.x * triSg.y, triP.z);
  vec2 uvZ = vec2(-triP.x * triSg.z, triP.y);
  TriAT aX = triAT(uvX), aY = triAT(uvY + 17.0), aZ = triAT(uvZ + 31.0);
  triDiff = triS(uTriDiff, uvX, aX) * triW.x + triS(uTriDiff, uvY, aY) * triW.y + triS(uTriDiff, uvZ, aZ) * triW.z;
  triArm = triS(uTriArm, uvX, aX) * triW.x + triS(uTriArm, uvY, aY) * triW.y + triS(uTriArm, uvZ, aZ) * triW.z;
  // whiteout-blended tangent-space normals -> object space
  vec3 tnX = triS(uTriNor, uvX, aX).xyz * 2.0 - 1.0;
  vec3 tnY = triS(uTriNor, uvY, aY).xyz * 2.0 - 1.0;
  vec3 tnZ = triS(uTriNor, uvZ, aZ).xyz * 2.0 - 1.0;
  tnX.xy *= uNorMix; tnY.xy *= uNorMix; tnZ.xy *= uNorMix;
  tnX.x *= triSg.x; tnY.x *= triSg.y; tnZ.x *= -triSg.z;
  tnX = vec3(tnX.xy + triN.zy, abs(tnX.z) * triN.x);
  tnY = vec3(tnY.xy + triN.xz, abs(tnY.z) * triN.y);
  tnZ = vec3(tnZ.xy + triN.xy, abs(tnZ.z) * triN.z);
  triNorO = normalize(tnX.zyx * triW.x + tnY.xzy * triW.y + tnZ.xyz * triW.z);
  vec3 triQ = vTriPos * uProcScale;
  triH = texture2D(uTriDetail, triQ.zy).r * triW.x + texture2D(uTriDetail, triQ.xz).r * triW.y + texture2D(uTriDetail, triQ.xy).r * triW.z;
  // the texture's u axis on this surface: brushing direction for anisotropy
  vec3 triBrush = vec3(0.0, 0.0, 1.0) * triW.x + vec3(1.0, 0.0, 0.0) * (triW.y + triW.z);
#endif
float triWear = 0.0;
#ifdef TRI_BAKE
  // convex edges, broken up by the texture so the wear is patchy
  triWear = smoothstep(0.58, 0.85, vTriBake.g + (triH - 0.5) * 0.25 + (triArm.g - uTriRoughMean) * 0.4) * uWear * uWearAll * min(uBakeAo, 1.0);
#endif
float triProc = mix(1.0, mix(uTriDark, 1.0, triH), uTriStrength);
vec3 triPhoto = clamp(triDiff.rgb / max(uTriMean, vec3(0.02)), 0.0, 3.0);
// low-frequency macro variation so large surfaces are not uniformly tinted
float triMacro = 1.0 + (triNoise(vTriPos.xz * 2.3 + vTriPos.y * 1.7) - 0.5) * 0.12 * uDiffMix;
diffuseColor.rgb *= mix(vec3(triProc), triPhoto, uDiffMix) * mix(1.0, triArm.r, uArmMix * 0.7) * triMacro;
#ifdef TRI_WEAR_PAINT
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.55, 0.54, 0.52), triWear);
#elif defined(TRI_WEAR_LIGHTEN)
  diffuseColor.rgb *= 1.0 + triWear * 0.45;
#endif
#ifdef TRI_BAKE
  diffuseColor.rgb *= mix(1.0, 0.55 + 0.45 * vTriBake.r, uBakeAo * 0.5);
#endif
float triUp = dot(triToView(triN), normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz));
float triDust = uDust * smoothstep(0.35, 0.95, triUp) * (0.6 + 0.4 * triNoise(vTriPos.xz * 40.0));
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.40, 0.37), triDust * 0.6);
`;

const ROUGH = `
float triR = roughnessFactor * mix(1.0 + (triH - 0.5) * uTriRough * 2.0, triArm.g / max(uTriRoughMean, 0.05), uArmMix);
#ifdef TRI_WEAR_PAINT
  triR = mix(triR, 0.35, triWear);
#elif defined(TRI_WEAR_METAL)
  triR *= 1.0 - triWear * 0.5;
#elif defined(TRI_WEAR_LIGHTEN)
  triR = mix(triR, min(1.0, triR * 1.4), triWear);
#endif
roughnessFactor = clamp(mix(triR, 1.0, triDust), 0.03, 1.0);
`;

const METAL = `
#ifdef TRI_WEAR_PAINT
  metalnessFactor = mix(metalnessFactor, 1.0, triWear);
#endif
`;

const NORMAL = `
#ifdef TRI_UV
  {
    mat3 triTbn = triFrame(-vViewPosition, normal, triUv);
    triTbn[0] *= faceDirection; triTbn[1] *= faceDirection;
    vec3 tn = triNorO; tn.xy *= uNorMix;
    normal = normalize(triTbn * tn);
  #ifdef USE_ANISOTROPY
    vec3 triT = normalize(triTbn[0] - normal * dot(triTbn[0], normal));
    tbn = mat3(cross(normal, triT), triT, normal);
  #endif
  }
#else
  normal = normalize(normal + triFace * (triToView(triNorO) - triToView(triN)));
  #ifdef USE_ANISOTROPY
  {
    vec3 triT = triToView(triBrush);
    triT = normalize(triT - normal * dot(triT, normal) + 1e-5);
    tbn = mat3(cross(normal, triT), triT, normal);
  }
  #endif
#endif
{
  // micro detail: height in metres (amplitude ~15% of a tile per unit bump), faded out before its
  // features (1/32..1/128 of a tile) get smaller than a couple of pixels
  float fade = clamp(1.0 - (length(fwidth(vTriPos * uProcScale)) * 64.0 - 0.25) * 2.0, 0.0, 1.0);
  normal = triPerturb(-vViewPosition, normal, vec2(dFdx(triH), dFdy(triH)) * (uTriBump * 0.15 / uProcScale * fade), faceDirection);
}
`;

const AO = `
#ifdef TRI_BAKE
{
  float triAo = mix(1.0, vTriBake.r, uBakeAo);
  reflectedLight.indirectDiffuse *= triAo;
  reflectedLight.indirectSpecular *= mix(1.0, triAo, 0.7);
}
#endif
`;

const DEBUG = `
if (uDbg > 0.5) {
  vec3 d = uDbg < 1.5 ? diffuseColor.rgb : uDbg < 2.5 ? vec3(roughnessFactor) : uDbg < 3.5 ? normal * 0.5 + 0.5 : uDbg < 4.5 ? vec3(triH) : vec3(0.0);
#ifdef TRI_BAKE
  if (uDbg > 4.5) d = vec3(vTriBake.r, vTriBake.g, triWear);
#endif
  gl_FragColor = vec4(pow(d, vec3(1.0 / 2.2)), 1.0);
}
`;

/** "oak__6e4a32" (USD) or "oak #6e4a32 roughness=0.4" (GLB from sand3d 1.6) -> "oak" */
export function kindOf(name: string | undefined): string | null {
  if (!name) return null;
  const k = name.split(/__| |#/)[0].toLowerCase();
  return KINDS[k] || k === 'glass' || k === 'light' ? k : null;
}

interface KindUniforms {
  uTriDiff: { value: THREE.Texture };
  uTriNor: { value: THREE.Texture };
  uTriArm: { value: THREE.Texture };
  uTriDetail: { value: THREE.Texture };
  uTriMean: { value: THREE.Color };
  uTriRoughMean: { value: number };
  uTriScale: { value: number };
  uProcScale: { value: number };
  uTriStrength: { value: number };
  uTriBump: { value: number };
  uTriRough: { value: number };
  uTriDark: { value: number };
  uDiffMix: { value: number };
  uArmMix: { value: number };
  uNorMix: { value: number };
  uWear: { value: number };
  uBakeAo: { value: number };
  uDust: { value: number };
  uDbg: { value: number };
  uWearAll: { value: number };
}
function pixel(r: number, g: number, b: number) {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
}
const white = pixel(255, 255, 255);
const armNeutral = pixel(255, 128, 0);
const flatNormal = pixel(128, 128, 255);

/** shared by every material: baked AO strength and dust on upward faces */
const globals = { uBakeAo: { value: 1 }, uWearAll: { value: 0 }, uDust: { value: 0 }, uDbg: { value: 0 } };
/** Strength of the ambient occlusion baked into rebuilt objects (0 = ignore the bake). */
export function setBakeStrength(v: number) {
  globals.uBakeAo.value = v;
}
/**
 * Edge wear from the baked convexity, 0..1. Off by default: per-vertex convexity interpolates
 * across whole faces on low-poly parts (a box's sides all read as "edge"), so it only looks right
 * on densely bevelled meshes. A real edge mask needs a per-object lightmap UV + texture.
 */
export function setEdgeWear(v: number) {
  globals.uWearAll.value = v;
}
/** Debug view: 0 off, 1 albedo, 2 roughness, 3 view normal, 4 detail height, 5 bake (AO, convexity, wear). */
export function setMaterialDebug(v: number) {
  globals.uDbg.value = v;
}
/** Dust settling on upward-facing surfaces, 0..1 (e.g. an attic or a long-closed room). */
export function setDust(v: number) {
  globals.uDust.value = v;
}

const pending: Promise<void>[] = [];
/** Resolves when every texture set requested so far has loaded (for lab screenshots). */
export function materialsReady(): Promise<void> {
  return Promise.all(pending).then(() => undefined);
}

/** one shared uniform block per kind: when the photo textures arrive, every material updates */
const kindUniforms = new Map<string, KindUniforms>();
function uniformsFor(kind: string, spec: KindSpec): KindUniforms {
  let u = kindUniforms.get(kind);
  if (u) return u;
  const uu: KindUniforms = {
    uTriDiff: { value: white }, uTriNor: { value: flatNormal }, uTriArm: { value: armNeutral }, uTriDetail: { value: tex(spec.tex) },
    uTriMean: { value: new THREE.Color(1, 1, 1) }, uTriRoughMean: { value: 0.5 },
    uTriScale: { value: 1 / spec.tile }, uProcScale: { value: 1 / spec.tile }, uTriStrength: { value: spec.strength }, uTriBump: { value: spec.bump },
    uTriRough: { value: spec.rough }, uTriDark: { value: spec.dark }, uDiffMix: { value: 0 }, uArmMix: { value: 0 }, uNorMix: { value: 0 },
    uWear: { value: spec.wear ?? 0 }, ...globals,
  };
  kindUniforms.set(kind, uu);
  // real scanned textures, tiled at their physical size
  const set: PbrMaps | null = pbr(kind, '1k');
  if (set) {
    pending.push(set.ready);
    set.ready.then(() => {
      if (!set.diff) return;
      uu.uTriDiff.value = set.diff;
      if (set.nor) uu.uTriNor.value = set.nor;
      if (set.arm) uu.uTriArm.value = set.arm;
      uu.uTriMean.value = set.mean;
      uu.uTriRoughMean.value = set.rough;
      uu.uTriScale.value = 1 / set.tile[0];
      uu.uDiffMix.value = spec.diff;
      uu.uArmMix.value = spec.arm;
      uu.uNorMix.value = set.nor ? spec.nor : 0;
      uu.uTriBump.value = spec.bump * spec.detail;
      uu.uTriStrength.value = 0;
    });
  }
  return uu;
}

const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/** The kind's physical parameters on a MeshPhysicalMaterial built from sand3d's standard one. */
function physical(m: THREE.MeshStandardMaterial, kind: string, spec: KindSpec): THREE.MeshPhysicalMaterial {
  const p = new THREE.MeshPhysicalMaterial();
  THREE.MeshStandardMaterial.prototype.copy.call(p, m);
  p.defines = { STANDARD: '', PHYSICAL: '' };
  p.name = m.name;
  const sandRough = m.roughness;
  p.roughness = THREE.MathUtils.clamp(sandRough, spec.r[0], spec.r[1]);
  if (spec.metal) {
    // measured F0, nudged toward sand3d's hue and most of the way toward its brightness
    // (sand3d uses dark "steel" for blackened / oxidised parts)
    const f0 = new THREE.Color(...spec.metal);
    const c = f0.clone().lerp(m.color, spec.tint ?? 0.3);
    const target = Math.max(0.1, THREE.MathUtils.lerp(lum(f0), lum(m.color), 0.65));
    c.multiplyScalar(target / Math.max(lum(c), 1e-3));
    p.color.copy(c);
    p.metalness = 1;
  } else if (kind === 'painted_metal') {
    p.metalness = Math.min(m.metalness, 0.4); // metallic-flake paint at most
  } else {
    p.metalness = 0;
  }
  if (spec.aniso) {
    p.anisotropy = spec.aniso;
  }
  let cc = spec.clearcoat ?? 0;
  let ccr = spec.clearcoatRough ?? 0.1;
  if (spec.varnish) {
    // a glossy sand3d wood is lacquered: clear film over the open grain
    cc = THREE.MathUtils.smoothstep(0.6, 0.25, sandRough) * 0.8;
    ccr = 0.08;
  }
  if (kind === 'painted_metal' && sandRough < 0.35) {
    cc = 1; // car paint / enamel
    ccr = 0.03;
  }
  if (kind === 'ceramic' && sandRough > 0.65) cc = 0; // unglazed terracotta / bisque
  if (cc > 0) {
    p.clearcoat = cc;
    p.clearcoatRoughness = ccr;
  }
  if (spec.sheen) {
    p.sheen = spec.sheen;
    p.sheenRoughness = spec.sheenRough ?? 0.5;
    p.sheenColor.copy(m.color).lerp(new THREE.Color(1, 1, 1), kind === 'velvet' ? 0.35 : 0.15);
    // velvet: the pile hides the dye face-on (dark) and lights up at grazing angles (sheen)
    if (kind === 'velvet') p.color.multiplyScalar(0.6);
  }
  if (spec.spec !== undefined) p.specularIntensity = spec.spec;
  if (spec.ior) p.ior = spec.ior;
  return p;
}

const WEAR_MODE: Record<string, string> = {
  painted_metal: 'TRI_WEAR_PAINT',
  oak: 'TRI_WEAR_LIGHTEN', walnut: 'TRI_WEAR_LIGHTEN', pine: 'TRI_WEAR_LIGHTEN', birch: 'TRI_WEAR_LIGHTEN', leather: 'TRI_WEAR_LIGHTEN', plastic: 'TRI_WEAR_LIGHTEN',
  steel: 'TRI_WEAR_METAL', brushed_steel: 'TRI_WEAR_METAL', aluminium: 'TRI_WEAR_METAL', brass: 'TRI_WEAR_METAL', copper: 'TRI_WEAR_METAL',
};

export interface EnhanceOpts {
  /** the geometry carries the per-vertex bake (COLOR_0 = AO, convexity) from rebuild.py --bake */
  bake?: boolean;
}

/**
 * The physically based version of a sand3d material. Returns a new material (the input is
 * left untouched) except for lights, which are lit in place. hasUv: geometry has metric UVs.
 */
export function enhance(m: THREE.MeshStandardMaterial, kind: string, hasUv = false, opts: EnhanceOpts = {}): THREE.MeshStandardMaterial {
  if (m.userData.enhanced) return m;
  if (kind === 'light') {
    m.userData.enhanced = true;
    m.emissive = m.color.clone();
    m.emissiveIntensity = 1.6;
    return m;
  }
  const spec = KINDS[kind];
  if (!spec) return m;
  const p = physical(m, kind, spec);
  p.userData.enhanced = true;
  p.userData.kind = kind;
  const u = uniformsFor(kind, spec);
  const defs: Record<string, string> = { ...(p.defines ?? {}) };
  if (hasUv) defs.TRI_UV = '';
  if (spec.antiTile) defs.TRI_ANTITILE = '';
  if (opts.bake) {
    defs.TRI_BAKE = '';
    if (WEAR_MODE[kind] && spec.wear) defs[WEAR_MODE[kind]] = '';
    p.vertexColors = false; // the colour attribute is our bake, read by the shader itself
  }
  p.defines = defs;
  p.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = VERT_DECL + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERT_BODY);
    sh.fragmentShader = FRAG_DECL + sh.fragmentShader
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + SAMPLE)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + ROUGH)
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n' + METAL)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + NORMAL)
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\n' + AO)
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n' + DEBUG);
  };
  p.customProgramCacheKey = () => 'tri3';
  return p;
}

/** Glass in sand3d becomes real transmissive glass (IOR 1.52, tinted by absorption). */
export function glassFrom(m: THREE.MeshStandardMaterial) {
  const tint = m.color.clone();
  const tinted = lum(tint) < 0.85;
  return new THREE.MeshPhysicalMaterial({
    name: m.name,
    color: tinted ? tint.clone().lerp(new THREE.Color(1, 1, 1), 0.5) : new THREE.Color(1, 1, 1),
    roughness: Math.min(0.12, m.roughness),
    metalness: 0,
    transmission: 1,
    thickness: 0.006,
    ior: 1.52,
    attenuationColor: tinted ? tint : new THREE.Color(1, 1, 1),
    attenuationDistance: tinted ? 0.03 : Infinity,
    specularIntensity: 1,
    transparent: true,
    opacity: 1,
    side: THREE.DoubleSide,
  });
}

/** Walk a loaded object and upgrade every sand3d material by its kind name. */
export function enhanceTree(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const g = mesh.geometry;
    const hasUv = !!g.getAttribute('uv');
    // sand3d programs never write vertex colours: a colour attribute is rebuild.py's bake
    const bake = !!g.getAttribute('color');
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const out = mats.map((mt) => {
      const sm = mt as THREE.MeshStandardMaterial;
      if (!sm.isMeshStandardMaterial) return mt;
      if (sm.userData.enhanced) return mt;
      const k = kindOf(sm.name);
      if (!k) return mt;
      if (k === 'glass') return (sm.userData.glass ??= glassFrom(sm));
      // one upgraded material per (source material, uv, bake): meshes share it
      const variants: Record<string, THREE.Material> = (sm.userData.variants ??= {});
      const key = `${hasUv}|${bake}`;
      return (variants[key] ??= enhance(sm, k, hasUv, { bake }));
    });
    mesh.material = Array.isArray(mesh.material) ? out : out[0];
  });
}
