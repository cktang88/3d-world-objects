import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { BAYER_GLSL } from './people';

/**
 * The far crowd: pedestrians beyond ~30 m drawn as one InstancedMesh per gender with a
 * vertex animation texture (VAT). At load, the 2.5k-triangle LOD body is skinned through the
 * walk and idle clips on the CPU (with the same slimming / clothing inflation the near shader
 * applies, at average settings) and the vertex positions and normals of every frame are stored
 * in float textures. The instance shader reads two frames and blends them; outfit colours,
 * hair and coat length are per-instance attributes painted from the bind pose like the near body.
 */

export interface FarBody {
  waist: number; neck: number; shoulderX: number; wristX: number; ankle: number; knee: number;
  armY: number; armZ: number; legX: number; legZ: number; height: number;
}
export interface FarSource {
  scene: THREE.Object3D;
  /** geometry -> body space at the bind pose */
  geo: THREE.Matrix4;
  clips: Map<string, THREE.AnimationClip>;
}
/** what one far person looks like this frame */
export interface FarInstance {
  matrix: THREE.Matrix4;
  /** 0 = walk, 1 = idle */
  clip: number;
  /** 0..1 through the clip */
  phase: number;
  /** the near person's fade (1 = far instance hidden, 0 = solid) */
  fade: number;
  top: THREE.Color; bottom: THREE.Color; shoe: THREE.Color; skin: THREE.Color; hair: THREE.Color;
  /** top style (0 tee .. 4 hoodie), sleeve end |x|, trouser hem y, hair style (0 none/short, 1 long, 2 buns/bob) */
  style: THREE.Vector4;
  /** coat skirt bottom y, or -1 */
  coat: number;
  /** bit 1 backpack, 2 crossbody bag, 4 bag in the left hand */
  props: number;
  bag: THREE.Color;
  /** an open umbrella overhead (rain), or null */
  umbrella: THREE.Color | null;
}
/** rigid props baked into the far-crowd body (shown per instance from FarInstance.props) */
function farProps(b: FarBody, female: boolean) {
  const sp = female ? 1.22 : 1.25;
  const m = (x: number, y: number, z: number, ry = 0) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)), new THREE.Vector3(1, 1, 1));
  return [
    { id: 1, bone: 'spine_03', geo: new THREE.BoxGeometry(0.3, 0.42, 0.15), m: m(0, sp - 0.04, -0.2) },
    { id: 2, bone: 'pelvis', geo: new THREE.BoxGeometry(0.22, 0.16, 0.07), m: m(-0.19, b.waist - 0.04, 0.02, -Math.PI / 2 + 0.25) },
    // in the T-pose the left arm points along +x: the bag hangs on along the arm, so it hangs
    // below the hand once the arm is down
    { id: 3, bone: 'hand_l', geo: new THREE.BoxGeometry(0.34, 0.1, 0.3), m: m(b.wristX + 0.24, b.armY, b.armZ) },
  ];
}
const _bm = new THREE.Matrix4(), _nm = new THREE.Matrix3();

const CLIPS = [
  { name: 'Walk_Loop', frames: 32 },
  { name: 'Idle_Loop', frames: 24 },
];

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _n = new THREE.Vector3();
const sstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** the near shader's bind-space slimming, at average settings (see bodyMaterial in people.ts) */
/** the near shader's reshaping (tubes for limbs, an ellipse for the torso; see bodyMaterial in
 *  people.ts) at average proportions; updates the position and normal, returns clothing bulk */
export function slim(p: THREE.Vector3, n: THREE.Vector3, b: FarBody, female: boolean, sh?: number[]) {
  // sh: one person's proportions (QA measures the drawn back with them); default average
  const [armR, thighR, hipRx, chestRx, hipRz, chestRz] = sh ?? (female ? [0.044, 0.086, 0.178, 0.148, 0.112, 0.122] : [0.05, 0.083, 0.165, 0.168, 0.108, 0.118]);
  const ax = Math.abs(p.x), waist = b.waist, neck = b.neck;
  const lerp = THREE.MathUtils.lerp;
  const wa = sstep(b.shoulderX - 0.03, b.shoulderX + 0.06, ax) * sstep(waist + 0.15, waist + 0.25, p.y);
  const wl = (1 - sstep(waist - 0.16, waist - 0.04, p.y)) * (p.y > b.ankle + 0.01 ? 1 : 0);
  const top = lerp(neck - 0.01, neck + 0.05, sstep(0.06, 0.11, ax));
  const wt = (1 - wa) * (1 - wl) * sstep(waist - 0.22, waist - 0.06, p.y) * (1 - sstep(top - 0.07, top, p.y));
  {
    const rt = lerp(armR, armR * 0.62, sstep(b.shoulderX, b.wristX, ax));
    const dy = p.y - b.armY, dz = p.z - b.armZ, l = Math.hypot(dy, dz) || 1;
    const k = wa * (1 - sstep(b.wristX - 0.05, b.wristX - 0.01, ax));
    p.y = lerp(p.y, b.armY + (dy / l) * rt, k);
    p.z = lerp(p.z, b.armZ + (dz / l) * rt, k);
    n.lerp(_t.set(0, dy / l, dz / l), k).normalize();
  }
  {
    const lx = Math.sign(p.x) * b.legX;
    const rt = lerp(thighR, thighR * 0.55, sstep(waist - 0.1, b.ankle + 0.05, p.y));
    const dx = p.x - lx, dz = p.z - b.legZ, l = Math.hypot(dx, dz) || 1;
    const k = wl * sstep(0, 0.05, ax);
    p.x = lerp(p.x, lx + (dx / l) * rt, k);
    p.z = lerp(p.z, b.legZ + (dz / l) * rt, k);
    n.lerp(_t.set(dx / l, 0, dz / l), k).normalize();
  }
  {
    const h = sstep(waist - 0.1, waist + 0.3, p.y);
    const rx = lerp(hipRx, chestRx, h) * (1 - 0.3 * sstep(neck - 0.12, neck + 0.04, p.y));
    const rz = lerp(hipRz, chestRz, h) * (1 - 0.25 * sstep(neck - 0.1, neck + 0.04, p.y));
    const ex = p.x / rx, ez = (p.z + 0.02) / rz, l = Math.hypot(ex, ez) || 1;
    p.x = lerp(p.x, (ex / l) * rx, wt);
    p.z = lerp(p.z, -0.02 + (ez / l) * rz, wt);
    n.lerp(_t.set(ex / l / rx, 0, ez / l / rz).normalize(), wt).normalize();
  }
  p.x -= Math.sign(p.x) * (female ? 0.006 : 0.04) * sstep(0.04, b.shoulderX + 0.04, ax) * sstep(waist + 0.05, waist + 0.2, p.y);
  // clothing layer: a little bulk on the torso, arms and legs
  return ax < b.wristX - 0.03 && p.y < neck - 0.02 ? 0.014 : p.y < b.ankle ? 0.012 : 0;
}
const _t = new THREE.Vector3();

export class FarCrowd {
  meshes: THREE.InstancedMesh[] = [];
  private attrs: Record<string, THREE.InstancedBufferAttribute>[] = [];
  private counts = [0, 0];
  /** true once both genders are baked and added */
  ready = false;
  private job: Generator<void, void, void>;
  constructor(group: THREE.Group, src: Record<'male' | 'female', FarSource>, body: Record<'male' | 'female', FarBody>, capacity: number) {
    const self = this;
    this.job = (function* () {
      for (const [gi, g] of (['male', 'female'] as const).entries()) {
        const it = self.build(src[g], body[g], g === 'female', capacity);
        let r = it.next();
        while (!r.done) {
          yield;
          r = it.next();
        }
        const mesh = r.value;
        mesh.name = `far-crowd-${g}`;
        group.add(mesh);
        self.meshes[gi] = mesh;
      }
      self.ready = true;
    })();
  }
  /** bake for up to `ms` milliseconds this frame (the bake is spread over frames to avoid a hitch) */
  pump(ms = 4) {
    const t0 = performance.now();
    while (!this.ready && performance.now() - t0 < ms) this.job.next();
  }
  private *build(src: FarSource, b: FarBody, female: boolean, capacity: number): Generator<void, THREE.InstancedMesh, void> {
    const model = skeletonClone(src.scene);
    let lod: THREE.SkinnedMesh | null = null;
    model.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh && /Body_LOD/.test(o.name)) lod = o as THREE.SkinnedMesh;
    });
    if (!lod) throw new Error('no Body_LOD in the people asset');
    const sk = lod as THREE.SkinnedMesh;
    const g = sk.geometry;
    // compact: only the vertices the LOD index uses
    const index = g.index!;
    const remap = new Map<number, number>();
    const used: number[] = [];
    const idx = new Uint32Array(index.count);
    for (let i = 0; i < index.count; i++) {
      const v = index.getX(i);
      let c = remap.get(v);
      if (c === undefined) {
        c = used.length;
        remap.set(v, c);
        used.push(v);
      }
      idx[i] = c;
    }
    const nv = used.length;
    const pos = g.attributes.position, nrm = g.attributes.normal;
    const geoInv = src.geo.clone().invert();
    const nGeo = new THREE.Matrix3().getNormalMatrix(src.geo), nGeoInv = new THREE.Matrix3().getNormalMatrix(geoInv);
    // bind positions in body space (for painting) and slimmed + inflated skinning input in geometry space
    const bind = new Float32Array(nv * 3), col = new Float32Array(nv);
    const skinIn: THREE.Vector3[] = [], skinN: THREE.Vector3[] = [];
    for (let c = 0; c < nv; c++) {
      const v = used[c];
      _v.fromBufferAttribute(pos, v).applyMatrix4(src.geo);
      _v.toArray(bind, c * 3);
      col[c] = c;
      _n.fromBufferAttribute(nrm, v).applyMatrix3(nGeo).normalize();
      const p = _v.clone();
      const infl = slim(p, _n, b, female);
      p.addScaledVector(_n, infl);
      skinIn.push(p.applyMatrix4(geoInv));
      skinN.push(_n.clone().applyMatrix3(nGeoInv).normalize());
    }
    // props: appended vertices, rigid on one bone each
    const props = farProps(b, female);
    const boneIdx = (n: string) => Math.max(0, sk.skeleton.bones.findIndex((bn) => bn.name === n));
    const pv: { body: THREE.Vector3; geo: THREE.Vector3; n: THREE.Vector3; bone: number; id: number }[] = [];
    const pIdx: number[] = [];
    for (const pr of props) {
      const g2 = pr.geo.index ? pr.geo : pr.geo;
      const base = nv + pv.length;
      const ps = g2.attributes.position, ns = g2.attributes.normal;
      const nm = new THREE.Matrix3().getNormalMatrix(pr.m);
      for (let i = 0; i < ps.count; i++) {
        const bp = new THREE.Vector3().fromBufferAttribute(ps, i).applyMatrix4(pr.m);
        const bn = new THREE.Vector3().fromBufferAttribute(ns, i).applyMatrix3(nm).normalize();
        pv.push({ body: bp, geo: bp.clone().applyMatrix4(geoInv), n: bn.clone().applyMatrix3(nGeoInv).normalize(), bone: boneIdx(pr.bone), id: pr.id });
      }
      const ix = g2.index!;
      for (let i = 0; i < ix.count; i++) pIdx.push(base + ix.getX(i));
    }
    const nAll = nv + pv.length;
    // bake every frame of each clip
    const rows = CLIPS.reduce((a, c) => a + c.frames, 0);
    const pTex = new Float32Array(nAll * rows * 4), nTex = new Float32Array(nAll * rows * 4);
    const mixer = new THREE.AnimationMixer(model);
    const meshWorld = new THREE.Matrix4();
    let row = 0;
    const clipRows: number[] = [];
    for (const c of CLIPS) {
      const clip = src.clips.get(c.name)!;
      mixer.stopAllAction();
      const act = mixer.clipAction(clip);
      act.reset().play();
      clipRows.push(row);
      for (let f = 0; f < c.frames; f++, row++) {
        yield;
        mixer.setTime((f / c.frames) * clip.duration);
        model.updateMatrixWorld(true);
        sk.skeleton.update();
        meshWorld.copy(sk.matrixWorld);
        for (let i = 0; i < nv; i++) {
          // position, and the normal from a tiny offset along it (no need to blend matrices by hand)
          _v.copy(skinIn[i]);
          sk.applyBoneTransform(used[i], _v);
          _v.applyMatrix4(meshWorld);
          _w.copy(skinIn[i]).addScaledVector(skinN[i], 0.01 / src.geo.getMaxScaleOnAxis());
          sk.applyBoneTransform(used[i], _w);
          _w.applyMatrix4(meshWorld).sub(_v).normalize();
          const o = (row * nAll + i) * 4;
          pTex[o] = _v.x; pTex[o + 1] = _v.y; pTex[o + 2] = _v.z; pTex[o + 3] = 1;
          nTex[o] = _w.x; nTex[o + 1] = _w.y; nTex[o + 2] = _w.z; nTex[o + 3] = 0;
        }
        // rigid props: geometry space -> bind -> bone -> back, then the mesh's world matrix
        for (let j = 0; j < pv.length; j++) {
          const q = pv[j];
          _bm.multiplyMatrices(sk.bindMatrixInverse, sk.skeleton.bones[q.bone].matrixWorld).multiply(sk.skeleton.boneInverses[q.bone]).multiply(sk.bindMatrix);
          _bm.premultiply(meshWorld);
          _v.copy(q.geo).applyMatrix4(_bm);
          _nm.getNormalMatrix(_bm);
          _w.copy(q.n).applyMatrix3(_nm).normalize();
          const o = (row * nAll + nv + j) * 4;
          pTex[o] = _v.x; pTex[o + 1] = _v.y; pTex[o + 2] = _v.z; pTex[o + 3] = 1;
          nTex[o] = _w.x; nTex[o + 1] = _w.y; nTex[o + 2] = _w.z; nTex[o + 3] = 0;
        }
      }
    }
    const tex = (d: Float32Array) => {
      const t = new THREE.DataTexture(d, nAll, rows, THREE.RGBAFormat, THREE.FloatType);
      t.minFilter = t.magFilter = THREE.NearestFilter;
      t.needsUpdate = true;
      return t;
    };
    const posTex = tex(pTex), nrmTex = tex(nTex);

    const geo = new THREE.BufferGeometry();
    const bindAll = new Float32Array(nAll * 3), colAll = new Float32Array(nAll), propId = new Float32Array(nAll);
    bindAll.set(bind);
    colAll.set(col);
    for (let j = 0; j < pv.length; j++) {
      pv[j].body.toArray(bindAll, (nv + j) * 3);
      colAll[nv + j] = nv + j;
      propId[nv + j] = pv[j].id;
    }
    const idxAll = new Uint32Array(idx.length + pIdx.length);
    idxAll.set(idx);
    idxAll.set(pIdx, idx.length);
    geo.setAttribute('position', new THREE.BufferAttribute(bindAll, 3));
    // (attribute slots are scarce: 16 at most, instanceMatrix takes 4) vertex index + prop id
    const vat = new Float32Array(nAll * 2);
    for (let i = 0; i < nAll; i++) {
      vat[i * 2] = colAll[i];
      vat[i * 2 + 1] = propId[i];
    }
    geo.setAttribute('vatIndex', new THREE.BufferAttribute(vat, 2));
    geo.setIndex(new THREE.BufferAttribute(idxAll, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.3);
    const ia = (n: number) => new THREE.InstancedBufferAttribute(new Float32Array(capacity * n), n).setUsage(THREE.DynamicDrawUsage);
    const a = { anim: ia(4), top: ia(3), bottom: ia(3), shoe: ia(3), skin: ia(3), hair: ia(3), style: ia(4), misc: ia(2) };
    for (const [k, v] of Object.entries(a)) geo.setAttribute(`i_${k}`, v);
    this.attrs.push(a);

    const mat = new THREE.MeshStandardMaterial({ roughness: 0.85 });
    const u = {
      uPos: { value: posTex }, uNrm: { value: nrmTex },
      uVat: { value: new THREE.Vector4(nAll, rows, 0, 0) },
      uClip: { value: new THREE.Vector4(clipRows[0], CLIPS[0].frames, clipRows[1], CLIPS[1].frames) },
      uB0: { value: new THREE.Vector4(b.waist, b.neck, b.shoulderX, b.ankle) },
      uB1: { value: new THREE.Vector4(b.wristX, b.knee, b.height, 0) },
    };
    mat.onBeforeCompile = (s) => {
      Object.assign(s.uniforms, u);
      s.vertexShader = s.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform sampler2D uPos, uNrm;
          uniform vec4 uVat, uClip;
          attribute vec2 vatIndex;
          attribute vec4 i_anim, i_style;
          attribute vec3 i_top, i_bottom, i_shoe, i_skin, i_hair;
          attribute vec2 i_misc; // coat bottom y, props bitmask
          varying vec3 vBody, vTop, vBottom, vShoe, vSkin, vHair, vBag;
          varying vec4 vStyle;
          varying float vCoat;
          varying float vFade, vProp;
          vec2 vatRow(float clip, float phase) {
            float start = clip < 0.5 ? uClip.x : uClip.z, n = clip < 0.5 ? uClip.y : uClip.w;
            float fr = fract(phase) * n;
            float f0 = floor(fr);
            return vec2(start + f0, start + mod(f0 + 1.0, n)) ;
          }`,
        )
        .replace(
          '#include <beginnormal_vertex>',
          `vec2 rr = vatRow(i_anim.x, i_anim.y);
          float ft = fract(fract(i_anim.y) * (i_anim.x < 0.5 ? uClip.y : uClip.w));
          float cx = (vatIndex.x + 0.5) / uVat.x;
          float propId = vatIndex.y, i_coat = i_misc.x, i_props = i_misc.y;
          vec3 objectNormal = normalize(mix(texture2D(uNrm, vec2(cx, (rr.x + 0.5) / uVat.y)).xyz, texture2D(uNrm, vec2(cx, (rr.y + 0.5) / uVat.y)).xyz, ft));
          #ifdef USE_TANGENT
            vec3 objectTangent = vec3( tangent.xyz );
          #endif`,
        )
        .replace(
          '#include <begin_vertex>',
          `vec3 transformed = mix(texture2D(uPos, vec2(cx, (rr.x + 0.5) / uVat.y)).xyz, texture2D(uPos, vec2(cx, (rr.y + 0.5) / uVat.y)).xyz, ft);
          // props this person does not carry collapse to a point (degenerate triangles)
          if (propId > 0.5 && mod(floor(i_props / pow(2.0, propId - 1.0)), 2.0) < 0.5) transformed = vec3(0.0);
          vProp = propId; // bag colour packed as 8-bit RGB in i_anim.w (attribute slots are scarce)
          float pk = i_anim.w;
          vec3 bagc = vec3(floor(pk / 65536.0), mod(floor(pk / 256.0), 256.0), mod(pk, 256.0)) / 255.0;
          vBag = pow(bagc, vec3(2.2)) * (propId > 2.5 ? 1.0 : 0.85);
          vBody = position; vTop = i_top; vBottom = i_bottom; vShoe = i_shoe; vSkin = i_skin; vHair = i_hair; vStyle = i_style; vCoat = i_coat; vFade = i_anim.z;`,
        );
      s.fragmentShader = s.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform vec4 uB0, uB1;
          varying vec3 vBody, vTop, vBottom, vShoe, vSkin, vHair;
          varying vec4 vStyle;
          varying float vCoat;
          varying float vFade, vProp;
          varying vec3 vBag;
          ${BAYER_GLSL}`,
        )
        .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (vFade > 0.0 && pedBayer(gl_FragCoord.xy) <= vFade) discard;')
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          {
            vec3 p = vBody;
            float ax = abs(p.x);
            float waist = uB0.x, neck = uB0.y, sx = uB0.z, ankle = uB0.w;
            vec3 c = vSkin;   // skin albedo as the near shader paints it (people.ts SKIN_TINT)
            float headTop = uB1.z * 0.96;
            bool arm = ax > sx && p.y > waist + 0.25;
            if (arm) { if (ax < vStyle.y) c = vTop; }
            else if (p.y < ankle) c = vShoe;
            else if (p.y > waist) {
              float nl = neck - 0.035 * smoothstep(0.0, 0.07, p.z) + 0.6 * max(0.0, ax - 0.07) + (vStyle.x > 1.5 ? 0.03 : 0.0);
              if (p.y < nl) c = vTop;
            } else if (vCoat > 0.0 && p.y > vCoat) c = vTop * 0.95;
            else if (p.y > waist - 0.08 && vStyle.x > 1.5 && ax < 0.24) c = vTop;
            else if (p.y > vStyle.z) c = vBottom;
            // painted hair: a cap over the crown and the back of the head; long styles down to the shoulders
            float hy = neck + mix(0.1, 0.225, smoothstep(-0.05, 0.05, p.z));
            if (!arm && p.y > hy && vStyle.w > -0.5) c = vHair;
            if (!arm && vStyle.w > 0.5 && p.z < -0.03 && p.y > neck - 0.12 && ax < 0.13) c = vHair;
            if (vProp > 0.5) c = vBag;
            diffuseColor.rgb = c;
          }`,
        );
    };
    mat.customProgramCacheKey = () => 'ped-far-vat-v3';
    const mesh = new THREE.InstancedMesh(geo, mat, capacity);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    return mesh;
  }
  begin() {
    this.counts[0] = this.counts[1] = 0;
    this.nUmb = 0;
  }
  /** open umbrellas of far people in the rain: one instanced draw */
  umbrellas: THREE.InstancedMesh | null = null;
  private nUmb = 0;
  setUmbrellaGeometry(geo: THREE.BufferGeometry, mat: THREE.Material, group: THREE.Group, capacity: number) {
    const m = new THREE.InstancedMesh(geo, mat, capacity);
    m.count = 0;
    m.frustumCulled = false;
    m.name = 'far-umbrellas';
    m.setColorAt(0, new THREE.Color(1, 1, 1));
    group.add(m);
    this.umbrellas = m;
  }
  add(female: boolean, inst: FarInstance) {
    const gi = female ? 1 : 0;
    const i = this.counts[gi];
    const mesh = this.meshes[gi];
    if (i >= mesh.instanceMatrix.count) return false;
    this.counts[gi]++;
    mesh.setMatrixAt(i, inst.matrix);
    const a = this.attrs[gi];
    const c8 = (v: number) => Math.round(THREE.MathUtils.clamp(Math.pow(v, 1 / 2.2), 0, 1) * 255);
    a.anim.setXYZW(i, inst.clip, inst.phase, inst.fade, c8(inst.bag.r) * 65536 + c8(inst.bag.g) * 256 + c8(inst.bag.b));
    a.top.setXYZ(i, inst.top.r, inst.top.g, inst.top.b);
    a.bottom.setXYZ(i, inst.bottom.r, inst.bottom.g, inst.bottom.b);
    a.shoe.setXYZ(i, inst.shoe.r, inst.shoe.g, inst.shoe.b);
    a.skin.setXYZ(i, inst.skin.r, inst.skin.g, inst.skin.b);
    a.hair.setXYZ(i, inst.hair.r, inst.hair.g, inst.hair.b);
    a.style.setXYZW(i, inst.style.x, inst.style.y, inst.style.z, inst.style.w);
    a.misc.setXY(i, inst.coat, inst.props);
    if (inst.umbrella && this.umbrellas && this.nUmb < this.umbrellas.instanceMatrix.count) {
      // canopy over the head, a little ahead: in the person's frame (scale included)
      _bm.makeTranslation(0.08, 1.45, 0.15).premultiply(inst.matrix);
      this.umbrellas.setMatrixAt(this.nUmb, _bm);
      this.umbrellas.setColorAt(this.nUmb++, inst.umbrella);
    }
    return true;
  }
  end() {
    if (this.umbrellas) {
      this.umbrellas.count = this.nUmb;
      this.umbrellas.instanceMatrix.needsUpdate = true;
      if (this.umbrellas.instanceColor) this.umbrellas.instanceColor.needsUpdate = true;
    }
    this.meshes.forEach((m, gi) => {
      m.count = this.counts[gi];
      m.instanceMatrix.needsUpdate = true;
      for (const at of Object.values(this.attrs[gi])) at.needsUpdate = true;
    });
  }
}
