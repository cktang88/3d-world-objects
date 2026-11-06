import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { gltf } from '../detail';
import { Rng, hashN } from '../rng';
import { CURB, AX, SZ, AVE, ST, SW } from './common';

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
}

function pickOutfit(r: Rng, gender: Gender): Outfit {
  const topStyle = r.pick([0, 1, 1, 2, 2, 3, 3, 3, 4]);
  const top = topStyle === 2 ? r.pick(PUFFER) : topStyle === 3 ? r.pick(COAT) : topStyle === 4 ? r.pick([...COAT, '#7a7f86', '#8a2a2a']) : r.pick(SHIRT);
  const bottomStyle = gender === 'female' ? r.pick([0, 0, 1, 3, 3]) : r.pick([0, 0, 0, 1, 1, topStyle === 0 ? 2 : 1]);
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
  };
}

// ---------------------------------------------------------------- shader: clothes painted on the skinned body
const REGION_GLSL = /* glsl */ `
uniform mat4 uGeo, uGeoInv;
uniform float uGeoScale;
uniform vec4 uSlimA; // arm thickness factor, arm axis y, arm axis z, shoulder |x|
uniform vec4 uSlimB; // leg thickness factor, leg axis |x|, shoulder pull-in (m), leg axis z
uniform vec4 uSlimC; // torso depth factor
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
  const b = BODY[g];
  const sleeve = o.topStyle === 0 ? b.shoulderX + 0.13 : b.wristX - 0.035;
  const hem = o.bottomStyle === 2 ? b.knee + 0.07 : b.ankle;
  const neck = b.neck + (o.topStyle === 2 || o.topStyle === 4 ? 0.035 : o.topStyle === 3 ? 0.02 : 0);
  const infl = [[0.006, 0.014, 0.034, 0.02, 0.018][o.topStyle], [0.007, 0.008, 0.007, 0.002][o.bottomStyle], 0.02];
  const u = {
    uGeo: { value: geo },
    uGeoScale: { value: geoScale },
    uGeoInv: { value: geo.clone().invert() },
    uSlimA: { value: new THREE.Vector4(r.range(0.74, 0.88), b.armY, b.armZ, b.shoulderX) },
    uSlimB: { value: new THREE.Vector4(r.range(0.82, 0.93), b.legX, g === 'male' ? r.range(0.015, 0.035) : r.range(0.0, 0.012), b.legZ) },
    uSlimC: { value: new THREE.Vector4(r.range(0.8, 0.95), b.neck, 0, 0) },
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
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vBody = (uGeo * vec4(position, 1.0)).xyz;
        // the base meshes are superheroes: slim limbs, narrow shoulders and flatten the chest
        vec3 bp = vBody;
        float bax = abs(bp.x);
        float wa = smoothstep(uSlimA.w - 0.02, uSlimA.w + 0.09, bax) * smoothstep(uCut.x + 0.15, uCut.x + 0.25, bp.y);
        vec2 ac = uSlimA.yz;
        bp.yz = ac + (bp.yz - ac) * mix(1.0, uSlimA.x, wa);
        bp.x -= sign(bp.x) * uSlimB.z * smoothstep(0.04, uSlimA.w + 0.04, bax) * smoothstep(uCut.x + 0.05, uCut.x + 0.2, bp.y);
        float wl = (1.0 - smoothstep(uCut.x - 0.14, uCut.x - 0.02, bp.y)) * smoothstep(0.0, 0.05, bax) * step(uBody.y, bp.y);
        vec2 lc = vec2(sign(bp.x) * uSlimB.y, uSlimB.w);
        bp.xz = lc + (bp.xz - lc) * mix(1.0, uSlimB.x, wl);
        float wt = smoothstep(uCut.x - 0.12, uCut.x, bp.y) * (1.0 - wa) * (1.0 - smoothstep(uCut.y - 0.06, uCut.y + 0.02, bp.y));
        bp.z = mix(bp.z, -0.03 + (bp.z + 0.03) * uSlimC.x, wt);
        // thinner neck and lower trapezius
        float wn = smoothstep(uSlimC.y - 0.14, uSlimC.y - 0.06, bp.y) * (1.0 - smoothstep(uSlimC.y + 0.03, uSlimC.y + 0.1, bp.y)) * (1.0 - smoothstep(0.07, 0.12, bax));
        bp.xz = vec2(0.0, -0.035) + (bp.xz - vec2(0.0, -0.035)) * mix(1.0, 0.86, wn);
        bp.y -= 0.018 * smoothstep(uSlimC.y - 0.16, uSlimC.y - 0.04, bp.y) * smoothstep(0.05, 0.1, bax) * (1.0 - smoothstep(uSlimA.w - 0.02, uSlimA.w + 0.04, bax)) * (1.0 - smoothstep(uSlimC.y, uSlimC.y + 0.06, bp.y));
        // bare feet shrink inside the shoe meshes riding the foot bones
        float wf = 1.0 - smoothstep(uBody.y - 0.03, uBody.y + 0.005, bp.y);
        vec3 fc = vec3(sign(bp.x) * uSlimB.y, 0.045, 0.0);
        bp = mix(bp, fc + (bp - fc) * vec3(0.75, 0.8, 0.85), wf);
        transformed = (uGeoInv * vec4(bp, 1.0)).xyz;
        float pr = pedRegion(vBody);
        float inf = pr == 1.0 ? uInfl.x : pr == 2.0 ? uInfl.y : pr == 3.0 ? uInfl.z : 0.0;
        transformed += normalize(normal) * (inf / uGeoScale);`,
      );
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
        if (pr < 0.5) diffuseColor.rgb *= uSkin;
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
  m.customProgramCacheKey = () => 'ped-body-v4';
  return m;
}

// ---------------------------------------------------------------- assets
interface BodyAsset {
  scene: THREE.Object3D;
  base: THREE.MeshStandardMaterial;
  hairBase: THREE.MeshStandardMaterial;
  geo: THREE.Matrix4;
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
      body[g] = { scene, base: sk.material as THREE.MeshStandardMaterial, hairBase: hairBase!, geo, geoScale, bindInv, clips };
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
  beanie: new THREE.SphereGeometry(0.112, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.55),
  cuff: new THREE.CylinderGeometry(0.106, 0.11, 0.05, 20, 1, true),
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
  g = mergeGeometries([paint(up.toNonIndexed(), upper), paint(so.toNonIndexed(), sole)])!;
  shoeGeos.set(k, g);
  return g;
}
const shoeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 });
const propMats = new Map<string, THREE.MeshStandardMaterial>();
function propMat(color: string, rough = 0.8) {
  const k = `${color}|${rough}`;
  let m = propMats.get(k);
  if (!m) propMats.set(k, (m = new THREE.MeshStandardMaterial({ color, roughness: rough })));
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
  private lod = 0;
  /** 0: full body; 1: ~2.5k-triangle body, no eyes/brows */
  setLod(l: number) {
    if (l === this.lod || !this.lodMesh || !this.fullMesh) return;
    this.lod = l;
    this.lodMesh.visible = l === 1;
    this.fullMesh.visible = l === 0;
    for (const m of this.faceMeshes) m.visible = l === 0;
  }
  constructor(public assets: PeopleAssets, r: Rng, public gender: Gender = r.chance(0.5) ? 'male' : 'female') {
    const A = assets.body[gender];
    const model = skeletonClone(A.scene);
    this.root = new THREE.Group();
    this.root.add(model);
    const o = pickOutfit(r, gender);
    const hm = hairMat(A.hairBase, o.hair);
    const bm = bodyMaterial(A.base, o, gender, A.geo, A.geoScale, r);
    model.traverse((x) => {
      if ((x as THREE.Bone).isBone) this.bones.set(x.name, x as THREE.Bone);
      const m = x as THREE.SkinnedMesh;
      if (!m.isSkinnedMesh) return;
      const name = (m.material as THREE.Material).name;
      if (/Superhero/i.test(name)) m.material = bm;
      else if (/Hair/i.test(name)) m.material = hm;
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
    const hat = r.chance(0.22);
    if (style && !hat) {
      const h = assets.hair.get(style);
      if (h) attach('Head', new THREE.Mesh(h.geo, hm), h.matrix);
    }
    if (gender === 'male' && r.chance(0.25)) {
      const h = assets.hair.get('Hair_Beard');
      if (h) attach('Head', new THREE.Mesh(h.geo, hm), h.matrix);
    }
    void head;
    const b = BODY[gender];
    const at = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) =>
      new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1));
    const headTop = gender === 'male' ? 1.712 : 1.655;
    if (hat) {
      const hc = r.pick(['#151515', '#2a2a2e', '#4a1f22', '#c8c4ba', '#1f3d5a', '#5a5a5a', '#8a6c4a']);
      const bm = propMat(hc, 0.95);
      attach('Head', new THREE.Mesh(propGeo.beanie, bm), at(0, headTop, -0.012).multiply(new THREE.Matrix4().makeScale(1, 1.05, 1.1)));
      attach('Head', new THREE.Mesh(propGeo.cuff, bm), at(0, headTop + 0.012, -0.012).multiply(new THREE.Matrix4().makeScale(1.02, 1, 1.12)));
    }
    // bags
    const bagRoll = r.next();
    const sp = gender === 'male' ? 1.25 : 1.22;
    if (bagRoll < 0.22) {
      const bc = r.pick(['#151517', '#22262e', '#3a3f45', '#2f3a2a', '#5a1a1c', '#1f3d5a']);
      const bm = propMat(bc, 0.7);
      attach('spine_03', new THREE.Mesh(propGeo.backpack, bm), at(0, sp - 0.04, -0.2 - (o.topStyle === 2 ? 0.03 : 0)));
      for (const s of [-1, 1]) attach('spine_03', new THREE.Mesh(propGeo.strap, bm), at(s * 0.1, sp + 0.17, 0.075 + (o.topStyle === 2 ? 0.03 : 0), -0.5, 0, 0));
    } else if (bagRoll < 0.4) {
      const bc = r.pick(['#151517', '#3a2416', '#5a3a22', '#7a1d1d', '#c8b48c', '#2a2c30']);
      attach('pelvis', new THREE.Mesh(propGeo.crossbody, propMat(bc, 0.5)), at(-0.19, b.waist - 0.04, 0.02, 0, -Math.PI / 2 + 0.25, 0));
    }
    // shoes (the bare feet are shrunk inside them in the shader)
    const dark = !/^#[de]/.test(o.shoe);
    const sg = shoeGeo(o.shoe, o.sole, gender === 'male' ? 0.285 : 0.255, dark && r.chance(0.3));
    for (const [s, bone] of [[1, 'foot_l'], [-1, 'foot_r']] as const) attach(bone, new THREE.Mesh(sg, shoeMat), at(s * b.legX, 0, gender === 'male' ? 0.02 : 0.025));
    // root scale: base meshes are tall; real NYC adults ~1.76 m (men) / 1.62 m (women)
    const target = (gender === 'male' ? 1.76 : 1.63) * r.range(0.94, 1.06);
    model.scale.setScalar(target / b.height);
    if (r.chance(0.3)) this.walkClip = 'Walk_Formal_Loop';
    this.twoHands = r.chance(0.3);
    this.mixer = new THREE.AnimationMixer(model);
    for (const [name, clip] of A.clips) this.actions.set(name, this.mixer.clipAction(clip));
    // a phone, shown for phone-users
    this.phone = attach('hand_r', new THREE.Mesh(propGeo.phone, propMat('#0c0c0e', 0.25)), at(-b.wristX - 0.075, b.armY - 0.035, b.armZ + 0.02, Math.PI / 2, 0, Math.PI / 2));
    this.phone.visible = false;
    this.setActivity('walk', r.range(0, 10));
  }
  setActivity(a: Activity, phase = 0) {
    this.activity = a;
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
    const w = this.actions.get(this.walkClip);
    if (w) w.timeScale = Math.max(0.5, v / (0.98 * this.model().scale.x * (BODY[this.gender].height / 1.83)));
  }
  private model() {
    return this.root.children[0];
  }
  setShadows(on: boolean) {
    for (const m of this.meshes) m.castShadow = on;
  }
  update(dt: number) {
    this.mixer.update(dt);
    if (this.activity === 'phone') this.phonePose();
  }
  twoHands = false;
  walkClip = 'Walk_Loop';
  /** hold the phone up in front of the chest and look down at it (aimed in world space, so it
   *  does not depend on the rig's local bone axes) */
  private phonePose() {
    const model = this.model();
    model.updateMatrixWorld(true);
    const rq = model.getWorldQuaternion(_q0);
    const aim = (bone: string, child: string, dir: THREE.Vector3) => {
      const b = this.bones.get(bone), c = this.bones.get(child);
      if (!b || !c || !b.parent) return;
      const from = c.getWorldPosition(_v1).sub(b.getWorldPosition(_v0)).normalize();
      const to = _v2.copy(dir).normalize().applyQuaternion(rq);
      const world = b.getWorldQuaternion(_q2).premultiply(_q1.setFromUnitVectors(from, to));
      b.quaternion.copy(b.parent.getWorldQuaternion(_q3).invert().multiply(world));
      b.updateMatrixWorld(true);
    };
    const turn = (bone: string, axis: THREE.Vector3, ang: number) => {
      const b = this.bones.get(bone);
      if (!b || !b.parent) return;
      const ax = _v2.copy(axis).applyQuaternion(rq);
      const world = b.getWorldQuaternion(_q2).premultiply(_q1.setFromAxisAngle(ax, ang));
      b.quaternion.copy(b.parent.getWorldQuaternion(_q3).invert().multiply(world));
      b.updateMatrixWorld(true);
    };
    // the model faces +z; its right side is -x
    aim('upperarm_r', 'lowerarm_r', _v3.set(0.12, -1, 0.18));
    aim('lowerarm_r', 'hand_r', _v3.set(0.45, 0.8, 0.6));
    if (this.twoHands) {
      aim('upperarm_l', 'lowerarm_l', _v3.set(-0.12, -1, 0.18));
      aim('lowerarm_l', 'hand_l', _v3.set(-0.45, 0.8, 0.6));
    }
    turn('neck_01', _v3.set(1, 0, 0), 0.25);
    turn('Head', _v3.set(1, 0, 0), 0.3);
  }
}
const _v0 = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q0 = new THREE.Quaternion(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();

// ---------------------------------------------------------------- the crowd
interface Ped {
  p: Person;
  axis: 'x' | 'z';
  dir: number;
  line: number;
  t: number;
  v: number;
  /** sidestep offset across the walking line (to pass the player and each other) */
  off: number;
  /** standing: seconds left before walking on */
  wait: number;
  tick: number;
  acc: number;
  /** a companion: walks beside this person, or stands facing them talking */
  buddy?: Ped;
  /** set on the companion: the person it follows */
  lead?: Ped;
  /** facing (radians) */
  yaw: number;
  /** speed this frame */
  v0?: number;
}
const COUNT = 84;
const yawOf = (axis: 'x' | 'z', dir: number) => (axis === 'x' ? (dir > 0 ? Math.PI / 2 : -Math.PI / 2) : dir > 0 ? 0 : Math.PI);

export class Pedestrians {
  peds: Ped[] = [];
  private rng: Rng;
  private assets: PeopleAssets | null = null;
  private frame = 0;
  constructor(private group: THREE.Group, seed: number) {
    this.rng = new Rng(hashN(seed, 909));
    loadPeopleAssets()
      .then((a) => (this.assets = a))
      .catch((e) => console.warn('people assets failed to load', e));
  }
  private place(pd: Ped, p: THREE.Vector3, ahead: boolean) {
    const r = this.rng;
    pd.axis = r.chance(0.55) ? 'x' : 'z';
    pd.dir = r.chance(0.5) ? 1 : -1;
    pd.off = 0;
    const standing = ahead ? r.chance(0.3) : r.chance(0.12);
    // the sidewalk runs from the curb (0) to the building line (SW); keep a little off both
    const inSw = pd.buddy ? r.range(0.9, SW - 1.6) : r.range(0.8, SW - 0.9);
    if (pd.axis === 'x') {
      const k = Math.round(p.z / SZ - 0.5) + (r.chance(0.6) ? 0 : r.int(-1, 1));
      pd.line = (k + 0.5) * SZ + r.pick([-1, 1]) * (ST / 2 + inSw);
      pd.t = p.x + (ahead ? r.range(-50, 50) : -pd.dir * r.range(40, 60));
    } else {
      const k = Math.round(p.x / AX - 0.5) + (r.chance(0.6) ? 0 : r.int(-1, 1));
      pd.line = (k + 0.5) * AX + r.pick([-1, 1]) * (AVE / 2 + inSw);
      pd.t = p.z + (ahead ? r.range(-50, 50) : -pd.dir * r.range(40, 60));
    }
    pd.v = r.range(1.05, 1.5);
    pd.yaw = yawOf(pd.axis, pd.dir);
    if (standing) {
      // wait at the corner, near the curb, facing across the street
      const crossAxis = pd.axis === 'x' ? 'z' : 'x';
      const period = crossAxis === 'x' ? AX : SZ;
      const half = (crossAxis === 'x' ? AVE : ST) / 2;
      const k = Math.round(pd.t / period - 0.5);
      const c = (k + 0.5) * period;
      const side = pd.t > c ? 1 : -1;
      pd.dir = -side;
      pd.t = c + side * (half + r.range(0.5, 1.6) + (pd.buddy ? 1.5 : 0));
      pd.line += r.range(-0.6, 0.6);
      pd.wait = r.range(6, 30) + (pd.buddy ? 20 : 0);
      pd.yaw = yawOf(pd.axis, pd.dir);
      if (pd.buddy) {
        pd.p.setActivity('talk', r.range(0, 5));
        pd.yaw += Math.PI / 2;
      } else pd.p.setActivity(r.chance(0.5) ? 'phone' : r.chance(0.25) ? 'talk' : 'idle', r.range(0, 5));
      if (!pd.buddy && pd.p.activity === 'talk') pd.yaw += r.pick([-1, 1]) * r.range(0.8, 2.2);
    } else {
      pd.wait = 0;
      pd.p.setActivity('walk', r.range(0, 5));
      pd.p.setSpeed(pd.v);
    }
    pd.p.root.rotation.y = pd.yaw;
  }
  update(dt: number, p: THREE.Vector3) {
    if (!this.assets) return;
    this.frame++;
    while (this.peds.length < COUNT) {
      const person = new Person(this.assets, this.rng);
      this.group.add(person.root);
      const pd: Ped = { p: person, axis: 'x', dir: 1, line: 0, t: 0, v: 1.3, off: 0, wait: 0, tick: this.peds.length, acc: 0, yaw: 0 };
      // about one in five people is out with a companion
      const prev = this.peds[this.peds.length - 1];
      if (prev && !prev.lead && !prev.buddy && this.rng.chance(0.25)) {
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
      if (pd.wait > 0) {
        pd.wait -= dt;
        if (pd.wait <= 0) {
          pd.yaw = yawOf(pd.axis, pd.dir);
          pd.p.root.rotation.y = pd.yaw;
          pd.p.setActivity('walk', 0);
          pd.p.setSpeed(pd.v);
        }
      } else {
        // pass the player and oncoming people: drift aside (to the right when meeting someone),
        // slow down when boxed in
        let target = 0, v = pd.v;
        const avoid = (oa: number, oc: number, oncoming: boolean) => {
          const ahead = (oa - pd.t) * pd.dir;
          const lat = oc - (pd.line + pd.off);
          if (ahead > -0.3 && ahead < 3.5 && Math.abs(lat) < 0.9) {
            // keep right: walking +x, your right is +z; walking +z, it is -x
            const right = (pd.axis === 'x' ? 1 : -1) * pd.dir;
            const away = oncoming ? right : lat > 0 ? -1 : 1;
            target = THREE.MathUtils.clamp(pd.off + away * (0.95 - Math.abs(lat)) + away * 0.1, -1.2, 1.2);
            if (ahead < 0.9) v *= oncoming ? 0.7 : 0.4;
          }
        };
        avoid(along, across, false);
        for (const o of this.peds) {
          if (o === pd || o === pd.buddy || o.lead === pd || o.axis !== pd.axis || o.lead) continue;
          if (Math.abs(o.line - pd.line) > 1.5 || Math.abs(o.t - pd.t) > 3.5) continue;
          avoid(o.t, o.line + o.off, o.wait <= 0 && o.dir !== pd.dir);
        }
        pd.off += THREE.MathUtils.clamp(target - pd.off, -1.0 * dt, 1.0 * dt);
        pd.t += pd.dir * v * dt;
        pd.p.setSpeed(v);
        const turn = THREE.MathUtils.clamp((target - pd.off) * 0.6, -0.4, 0.4) * (pd.axis === 'x' ? -1 : 1) * pd.dir;
        pd.yaw = yawOf(pd.axis, pd.dir) + turn;
        pd.p.root.rotation.y = pd.yaw;
        pd.v0 = v;
      }
      const lineNow = pd.line + pd.off;
      pd.p.root.position.set(pd.axis === 'x' ? pd.t : lineNow, CURB, pd.axis === 'x' ? lineNow : pd.t);
      if (pd.buddy) this.follow(pd.buddy, pd);
    }
    for (const pd of this.peds) {
      // LOD: animate near people every frame, far ones every 2nd / 4th frame; shadows only nearby
      const d = Math.hypot(pd.p.root.position.x - p.x, pd.p.root.position.z - p.z);
      const every = d < 25 ? 1 : d < 50 ? 2 : 4;
      pd.acc += dt;
      if ((this.frame + pd.tick) % every === 0) {
        pd.p.update(pd.acc);
        pd.acc = 0;
      }
      pd.p.setShadows(d < 30);
      pd.p.setLod(d < 22 ? 0 : 1);
    }
  }
  /** companions walk shoulder to shoulder, or stand facing the leader while talking */
  private follow(f: Ped, l: Ped) {
    const lp = l.p.root.position;
    f.axis = l.axis;
    f.dir = l.dir;
    if (l.wait > 0) {
      if (f.p.activity !== 'talk' && f.p.activity !== 'idle') f.p.setActivity(this.rng.chance(0.5) ? 'talk' : 'idle', 1.3);
      f.p.root.position.set(lp.x + Math.sin(l.yaw) * 0.95, CURB, lp.z + Math.cos(l.yaw) * 0.95);
      f.p.root.rotation.y = l.yaw + Math.PI;
    } else {
      if (f.p.activity !== 'walk') f.p.setActivity('walk', 0.3);
      f.p.setSpeed(l.v0 ?? l.v);
      // to the leader's left
      const left = l.yaw + Math.PI / 2;
      f.p.root.position.set(lp.x + Math.sin(left) * 0.62, CURB, lp.z + Math.cos(left) * 0.62);
      f.p.root.rotation.y = l.yaw;
    }
  }
}
