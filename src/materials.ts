import * as THREE from 'three';

/**
 * sand3d writes each material as a flat UsdPreviewSurface, but names it after its kind:
 * "oak__6e4a32", "brushed_steel__9aa0a6", "fabric__…". We turn the kind back into surface
 * detail with a triplanar shader (no UVs needed): wood grain, brushed metal, weave,
 * leather grain, marble veins, concrete pores, plus roughness variation and bump.
 */

interface KindSpec {
  tex: 'grain' | 'brushed' | 'smudge' | 'peel' | 'micro' | 'weave' | 'leather' | 'marble' | 'concrete' | 'rubber';
  tile: number; // metres per texture repeat
  strength: number; // colour variation
  bump: number;
  rough: number; // roughness variation
  dark: number; // how dark the dark parts of the pattern get
}

const KINDS: Record<string, KindSpec> = {
  oak: { tex: 'grain', tile: 0.45, strength: 0.55, bump: 0.9, rough: 0.2, dark: 0.55 },
  walnut: { tex: 'grain', tile: 0.4, strength: 0.6, bump: 0.9, rough: 0.2, dark: 0.45 },
  pine: { tex: 'grain', tile: 0.5, strength: 0.45, bump: 0.7, rough: 0.2, dark: 0.62 },
  birch: { tex: 'grain', tile: 0.5, strength: 0.3, bump: 0.5, rough: 0.15, dark: 0.75 },
  steel: { tex: 'brushed', tile: 0.25, strength: 0.14, bump: 0.25, rough: 0.3, dark: 0.75 },
  brushed_steel: { tex: 'brushed', tile: 0.2, strength: 0.18, bump: 0.3, rough: 0.35, dark: 0.7 },
  aluminium: { tex: 'brushed', tile: 0.2, strength: 0.12, bump: 0.2, rough: 0.3, dark: 0.8 },
  chrome: { tex: 'smudge', tile: 0.6, strength: 0.04, bump: 0.05, rough: 0.12, dark: 0.85 },
  brass: { tex: 'smudge', tile: 0.4, strength: 0.18, bump: 0.1, rough: 0.25, dark: 0.7 },
  copper: { tex: 'smudge', tile: 0.4, strength: 0.22, bump: 0.1, rough: 0.25, dark: 0.65 },
  painted_metal: { tex: 'peel', tile: 0.12, strength: 0.06, bump: 0.25, rough: 0.12, dark: 0.85 },
  plastic: { tex: 'micro', tile: 0.06, strength: 0.05, bump: 0.15, rough: 0.12, dark: 0.85 },
  glossy_plastic: { tex: 'micro', tile: 0.08, strength: 0.03, bump: 0.06, rough: 0.06, dark: 0.9 },
  rubber: { tex: 'rubber', tile: 0.04, strength: 0.12, bump: 0.4, rough: 0.1, dark: 0.7 },
  fabric: { tex: 'weave', tile: 0.025, strength: 0.3, bump: 0.7, rough: 0.05, dark: 0.6 },
  velvet: { tex: 'weave', tile: 0.012, strength: 0.25, bump: 0.4, rough: 0.05, dark: 0.55 },
  leather: { tex: 'leather', tile: 0.05, strength: 0.25, bump: 0.8, rough: 0.2, dark: 0.6 },
  marble: { tex: 'marble', tile: 0.7, strength: 0.6, bump: 0.05, rough: 0.1, dark: 0.45 },
  concrete: { tex: 'concrete', tile: 0.5, strength: 0.35, bump: 0.7, rough: 0.15, dark: 0.6 },
  ceramic: { tex: 'micro', tile: 0.15, strength: 0.03, bump: 0.04, rough: 0.05, dark: 0.9 },
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

function makeTex(kind: KindSpec['tex']): THREE.DataTexture {
  const data = new Uint8Array(S * S * 4);
  for (let j = 0; j < S; j++)
    for (let i = 0; i < S; i++) {
      const u = i / S, v = j / S;
      let h = 0.5;
      switch (kind) {
        case 'grain': {
          // rings stretched along v, warped by noise
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
          // cellular grain
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
function tex(kind: KindSpec['tex']) {
  let t = texCache.get(kind);
  if (!t) {
    t = makeTex(kind);
    texCache.set(kind, t);
  }
  return t;
}

// ---- shader injection ---------------------------------------------------------

const VERT_DECL = 'varying vec3 vTriPos;\nvarying vec3 vTriNrm;\n';
const FRAG_DECL = `
varying vec3 vTriPos;
varying vec3 vTriNrm;
uniform sampler2D uTriMap;
uniform float uTriScale, uTriStrength, uTriBump, uTriRough, uTriDark;
float triSample(vec3 p, vec3 n) {
  vec3 w = pow(abs(n), vec3(4.0));
  w /= max(w.x + w.y + w.z, 1e-4);
  p *= uTriScale;
  // the grain runs along the longest axis of each projection
  return texture2D(uTriMap, p.zy).r * w.x + texture2D(uTriMap, p.xz).r * w.y + texture2D(uTriMap, p.xy).r * w.z;
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
`;

export function kindOf(name: string | undefined): string | null {
  if (!name) return null;
  const k = name.split('__')[0].toLowerCase();
  return KINDS[k] || k === 'glass' || k === 'light' ? k : null;
}

/** Add procedural surface detail to a standard material in place. */
export function enhance(m: THREE.MeshStandardMaterial, kind: string) {
  if (m.userData.enhanced) return m;
  m.userData.enhanced = true;
  if (kind === 'light') {
    m.emissive = m.color.clone();
    m.emissiveIntensity = 1.6;
    return m;
  }
  const spec = KINDS[kind];
  if (!spec) return m;
  const map = tex(spec.tex);
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTriMap = { value: map };
    sh.uniforms.uTriScale = { value: 1 / spec.tile };
    sh.uniforms.uTriStrength = { value: spec.strength };
    sh.uniforms.uTriBump = { value: spec.bump };
    sh.uniforms.uTriRough = { value: spec.rough };
    sh.uniforms.uTriDark = { value: spec.dark };
    sh.vertexShader = VERT_DECL + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvTriPos = position;\nvTriNrm = normal;');
    sh.fragmentShader = FRAG_DECL + sh.fragmentShader
      .replace('#include <color_fragment>', '#include <color_fragment>\nfloat triH = triSample(vTriPos, vTriNrm);\ndiffuseColor.rgb *= mix(1.0, mix(uTriDark, 1.0, triH), uTriStrength);')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor + (triH - 0.5) * uTriRough, 0.03, 1.0);')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = triPerturb(-vViewPosition, normal, vec2(dFdx(triH), dFdy(triH)) * uTriBump, faceDirection);');
  };
  m.customProgramCacheKey = () => `tri-${spec.tex}`;
  m.needsUpdate = true;
  return m;
}

/** Glass in sand3d becomes real transmissive glass. */
export function glassFrom(m: THREE.MeshStandardMaterial) {
  return new THREE.MeshPhysicalMaterial({
    color: m.color,
    roughness: Math.min(0.15, m.roughness),
    metalness: 0,
    transmission: 0.92,
    thickness: 0.01,
    ior: 1.5,
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
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const out = mats.map((mt) => {
      const sm = mt as THREE.MeshStandardMaterial;
      if (!sm.isMeshStandardMaterial) return mt;
      const k = kindOf(sm.name);
      if (!k) return mt;
      if (k === 'glass') return (sm.userData.glass ??= glassFrom(sm));
      return enhance(sm, k);
    });
    mesh.material = Array.isArray(mesh.material) ? out : out[0];
  });
}
