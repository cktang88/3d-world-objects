import * as THREE from 'three';
import { Rng } from '../rng';
import { mat, glow } from '../build';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { SIG, CURB, AX, SZ, BX, BZ, LX, LZ, streetName } from './common';
import { rect, overlaps, type Rect as LRect } from '../level';
import { addTree, pickSpecies, TREE_VARIANTS, type Species } from './streettrees';
import { streetLightMarker } from '../lighting';
import { propAtlas, propAtlasLit, region, signSlot, toRect, wireMesh, type Rect, type Region } from './propatlas';

/** Street furniture: signals, name signs, lamp posts, trees, hydrants, subway entrances and the rest. */

// ---------------------------------------------------------------- shared prop helpers

const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3();
/** add a mesh of a shared geometry with position / yaw (and optional pitch/roll, scale) — baked later */
export function put(parent: THREE.Object3D, geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, ry = 0, shadow = true, rx = 0, rz = 0, sc: number | [number, number, number] = 1) {
  const o = new THREE.Mesh(geo, m);
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  if (typeof sc === 'number') _s.setScalar(sc);
  else _s.set(...sc);
  o.matrixAutoUpdate = false;
  o.matrix.compose(_v.set(x, y, z), _q, _s);
  o.castShadow = shadow;
  parent.add(o);
  return o;
}
/** child transform helper: run `fn` with a group placed at (x,y,z,ry); everything added to it is baked in place */
export function at(parent: THREE.Object3D, x: number, y: number, z: number, ry: number, fn: (g: THREE.Group) => void) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  parent.add(g);
  fn(g);
  return g;
}
const geoCache = new Map<string, THREE.BufferGeometry>();
export function cachedGeo(key: string, make: () => THREE.BufferGeometry) {
  let g = geoCache.get(key);
  if (!g) {
    g = make();
    geoCache.set(key, g);
  }
  return g;
}
/** LatheGeometry from a [radius, y] profile */
export function lathe(key: string, prof: [number, number][], seg = 16) {
  return cachedGeo(`lathe:${key}`, () => new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), seg));
}
export function rbox(key: string, w: number, h: number, d: number, r: number, seg = 2) {
  return cachedGeo(`rbox:${key}`, () => {
    const g = new RoundedBoxGeometry(w, h, d, seg, r);
    g.translate(0, h / 2, 0);
    return g;
  });
}
export function cyl(key: string, rt: number, rb: number, h: number, seg = 12, open = false) {
  return cachedGeo(`cyl:${key}`, () => {
    const g = new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);
    g.translate(0, h / 2, 0);
    return g;
  });
}
/** tube along a polyline/curve */
export function tube(key: string, pts: THREE.Vector3[], r: number, tubular = 24, radial = 8) {
  return cachedGeo(`tube:${key}`, () => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.2), tubular, r, radial, false));
}

/** painted / galvanised metals shared by all street furniture */
export const PM = {
  black: () => mat('#17181a', { rough: 0.45, metal: 0.55 }),
  galv: () => mat('#8d9192', { rough: 0.42, metal: 0.85 }),
  galvDark: () => mat('#5f6466', { rough: 0.5, metal: 0.8 }),
  dotGreen: () => mat('#1f4a33', { rough: 0.5, metal: 0.4 }),
  signalYellow: () => mat('#e6b414', { rough: 0.5, metal: 0.15 }),
  signalBlack: () => mat('#141516', { rough: 0.55, metal: 0.2 }),
  granite: () => mat('#9b968d', { rough: 0.85 }),
  concrete: () => mat('#a39f97', { rough: 0.95 }),
};

// ---------------------------------------------------------------- street trees

/** NYC tree guard: black steel, 18 in high, top rail with hairpin loops and pickets */
function guardGeo(L: number, W: number) {
  return cachedGeo(`guard:${L}x${W}`, () => {
    const parts: THREE.BufferGeometry[] = [];
    const H = 0.46;
    const add = (g: THREE.BufferGeometry, x: number, y: number, z: number, ry = 0) => {
      g.rotateY(ry);
      g.translate(x, y, z);
      parts.push(g.index ? g.toNonIndexed() : g);
    };
    const sides: [number, number, number, number][] = [
      [0, -W / 2, L, 0], [0, W / 2, L, 0], [-L / 2, 0, W, Math.PI / 2], [L / 2, 0, W, Math.PI / 2],
    ];
    for (const [cx, cz, len, ry] of sides) {
      // top and bottom rails (flat bar)
      add(new THREE.BoxGeometry(len, 0.02, 0.04), cx, H, cz, ry);
      add(new THREE.BoxGeometry(len, 0.035, 0.016), cx, 0.09, cz, ry);
      // hairpin loops hanging from the top rail
      const n = Math.round(len / 0.16);
      for (let i = 0; i < n; i++) {
        const t = -len / 2 + (i + 0.5) * (len / n);
        const loop = new THREE.TorusGeometry(0.06, 0.009, 4, 8, Math.PI);
        loop.rotateZ(Math.PI);
        // legs of the hairpin
        const legs = new THREE.BoxGeometry(0.016, H - 0.09 - 0.06, 0.016);
        const lx = Math.cos(ry) * t, lz = -Math.sin(ry) * t;
        add(loop, cx + lx, H - 0.0, cz + lz, ry);
        const l1 = legs.clone(), l2 = legs;
        add(l1, cx + lx + Math.cos(ry) * 0.06, 0.09 + (H - 0.15) / 2, cz + lz - Math.sin(ry) * 0.06, ry);
        add(l2, cx + lx - Math.cos(ry) * 0.06, 0.09 + (H - 0.15) / 2, cz + lz + Math.sin(ry) * 0.06, ry);
      }
    }
    // corner posts with ball finials, driven into the soil
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      add(new THREE.BoxGeometry(0.04, H + 0.02, 0.04), (sx * L) / 2, (H + 0.02) / 2, (sz * W) / 2);
      add(new THREE.SphereGeometry(0.028, 8, 6), (sx * L) / 2, H + 0.04, (sz * W) / 2);
    }
    for (const p of parts) for (const k of Object.keys(p.attributes)) if (!['position', 'normal', 'uv'].includes(k)) p.deleteAttribute(k);
    return mergeGeometries(parts, false)!;
  });
}

/**
 * A street tree in its pit: granite-edged soil pit along the kerb, an optional steel guard, and an
 * instanced procedural tree (per-chunk LOD) added to `group`.
 */
export function tree(stat: THREE.Object3D, x: number, z: number, rng: Rng, group: THREE.Object3D, axis: 'x' | 'z' = 'x', species?: Species) {
  const ry = axis === 'x' ? 0 : Math.PI / 2;
  const L = 2.4, W = 1.2;
  at(stat, x, CURB, z, ry, (g) => {
    // pit soil, slightly sunk, with a raised granite / concrete edge
    put(g, cachedGeo('pitSoil', () => {
      const p = new THREE.PlaneGeometry(L, W);
      p.rotateX(-Math.PI / 2);
      return toRect(p, region('soil'));
    }), propAtlas(), 0, 0.012, 0, 0, false);
    const edge = PM.granite();
    put(g, rbox('pitEdgeL', L + 0.2, 0.05, 0.1, 0.012), edge, 0, -0.01, W / 2 + 0.05, 0, false);
    put(g, rbox('pitEdgeL', L + 0.2, 0.05, 0.1, 0.012), edge, 0, -0.01, -W / 2 - 0.05, 0, false);
    put(g, rbox('pitEdgeW', 0.1, 0.05, W, 0.012), edge, L / 2 + 0.05, -0.01, 0, 0, false);
    put(g, rbox('pitEdgeW', 0.1, 0.05, W, 0.012), edge, -L / 2 - 0.05, -0.01, 0, 0, false);
    if (rng.chance(0.6)) put(g, guardGeo(L, W), PM.black(), 0, 0, 0, 0, true);
  });
  // block-dominant species, the odd one different
  let sp = species;
  if (!sp) {
    group.userData.treeSpecies ??= pickSpecies(rng);
    group.userData.treeVariant ??= rng.int(0, TREE_VARIANTS - 1);
    // one secondary species per block: at most two instanced pairs (4 draw calls) per chunk
    for (let k = 0; k < 6 && !group.userData.treeSecond; k++) {
      const s2 = pickSpecies(rng);
      if (s2 !== group.userData.treeSpecies) group.userData.treeSecond = s2;
    }
    group.userData.treeSecond ??= group.userData.treeSpecies === 'plane' ? 'locust' : 'plane';
    sp = rng.chance(0.7) ? group.userData.treeSpecies : group.userData.treeSecond;
  }
  addTree(group, sp!, sp === group.userData.treeSpecies ? group.userData.treeVariant ?? 0 : 0, x + (axis === 'x' ? rng.range(-0.3, 0.3) : 0), CURB + 0.01, z + (axis === 'z' ? rng.range(-0.3, 0.3) : 0), rng);
}

// ---------------------------------------------------------------- kits: prebuilt, per-material merged props

export interface KitPart { geo: THREE.BufferGeometry; mat: THREE.Material; shadow: boolean }
const _km = new THREE.Matrix4(), _kq = new THREE.Quaternion(), _ke = new THREE.Euler();
function normGeo(g: THREE.BufferGeometry, keepColor = false) {
  let o = g.index ? g.toNonIndexed() : g.clone();
  for (const k of Object.keys(o.attributes)) if (!['position', 'normal', 'uv'].includes(k) && !(keepColor && k === 'color')) o.deleteAttribute(k);
  if (keepColor && !o.getAttribute('color')) o.setAttribute('color', new THREE.BufferAttribute(new Float32Array(o.getAttribute('position').count * 3).fill(1), 3));
  if (!o.getAttribute('normal')) o.computeVertexNormals();
  if (!o.getAttribute('uv')) o.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(o.getAttribute('position').count * 2), 2));
  return o;
}
export class KitBuilder {
  private parts = new Map<string, { mat: THREE.Material; shadow: boolean; geos: THREE.BufferGeometry[] }>();
  /** add a copy of `geo` transformed by position / euler (YXZ) / scale */
  add(geo: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sc: number | [number, number, number] = 1, shadow = true) {
    const g = normGeo(geo, (m as THREE.MeshStandardMaterial).vertexColors);
    _ke.set(rx, ry, rz, 'YXZ');
    _kq.setFromEuler(_ke);
    _km.compose(new THREE.Vector3(x, y, z), _kq, typeof sc === 'number' ? new THREE.Vector3(sc, sc, sc) : new THREE.Vector3(...sc));
    g.applyMatrix4(_km);
    const key = `${m.uuid}|${shadow}`;
    let p = this.parts.get(key);
    if (!p) this.parts.set(key, (p = { mat: m, shadow, geos: [] }));
    p.geos.push(g);
    return this;
  }
  /** add with an arbitrary matrix */
  addM(geo: THREE.BufferGeometry, m: THREE.Material, mx: THREE.Matrix4, shadow = true) {
    const g = normGeo(geo, (m as THREE.MeshStandardMaterial).vertexColors);
    g.applyMatrix4(mx);
    const key = `${m.uuid}|${shadow}`;
    let p = this.parts.get(key);
    if (!p) this.parts.set(key, (p = { mat: m, shadow, geos: [] }));
    p.geos.push(g);
    return this;
  }
  build(): KitPart[] {
    const out: KitPart[] = [];
    for (const p of this.parts.values()) {
      const geo = mergeGeometries(p.geos, false)!;
      p.geos.forEach((g) => g.dispose());
      geo.computeBoundingSphere();
      out.push({ geo, mat: p.mat, shadow: p.shadow });
    }
    return out;
  }
}
const kits = new Map<string, KitPart[]>();
export function kit(key: string, fn: (k: KitBuilder) => void) {
  let k = kits.get(key);
  if (!k) {
    const b = new KitBuilder();
    fn(b);
    k = b.build();
    kits.set(key, k);
  }
  return k;
}
/** place a kit (baked later into the chunk) */
export function place(parent: THREE.Object3D, parts: KitPart[], x: number, y: number, z: number, ry = 0, sc: number | [number, number, number] = 1) {
  for (const p of parts) put(parent, p.geo, p.mat, x, y, z, ry, p.shadow, 0, 0, sc);
}
/** a geometry with its faces flipped (inner walls of thin shells) */
function flipped(g: THREE.BufferGeometry) {
  const o = normGeo(g);
  const pos = o.getAttribute('position') as THREE.BufferAttribute;
  const nor = o.getAttribute('normal') as THREE.BufferAttribute;
  const uv = o.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i += 3) {
    for (const a of [pos, nor, uv]) {
      const s = a.itemSize;
      for (let c = 0; c < s; c++) {
        const t = a.array[(i + 1) * s + c];
        (a.array as Float32Array)[(i + 1) * s + c] = a.array[(i + 2) * s + c];
        (a.array as Float32Array)[(i + 2) * s + c] = t;
      }
    }
  }
  for (let i = 0; i < nor.count; i++) nor.setXYZ(i, -nor.getX(i), -nor.getY(i), -nor.getZ(i));
  return o;
}
/** a cylinder between two points */
function rod(k: KitBuilder, a: THREE.Vector3, b: THREE.Vector3, r: number, m: THREE.Material, seg = 6) {
  const d = b.clone().sub(a);
  const g = new THREE.CylinderGeometry(r, r, d.length(), seg);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
  k.addM(g, m, new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)));
}
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
function plane(w: number, h: number, r?: Rect) {
  const g = new THREE.PlaneGeometry(w, h);
  if (r) toRect(g, r);
  return g;
}
/**
 * One shared self-lit material for every luminaire (street-light lenses, crook lanterns, subway
 * globes, shed lights): vertex colours tint both the base and the glow, so they all bake into a
 * single draw call per chunk. Its emissive is the lamp colour lighting.ts boosts at night.
 */
let glowMat: THREE.MeshStandardMaterial | null = null;
export function glowVC() {
  if (!glowMat) {
    glowMat = new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, emissive: new THREE.Color('#ffe2b0'), emissiveIntensity: 1.3, roughness: 0.3 });
    glowMat.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n#ifdef USE_COLOR\n totalEmissiveRadiance *= vColor.rgb;\n#endif');
    };
    glowMat.customProgramCacheKey = () => 'nyc-glow-vc';
  }
  return glowMat;
}
/** a geometry copy carrying a uniform vertex colour (for glowVC) */
function tinted(g: THREE.BufferGeometry, hex: string) {
  const o = g.index ? g.toNonIndexed() : g.clone();
  const c = new THREE.Color(hex);
  const n = o.getAttribute('position').count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  o.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return o;
}
const lampLens = () => glowVC();

// ---------------------------------------------------------------- traffic signals

/**
 * All six signal lenses (red/yellow/green × avenue/street) in ONE material: the vertex colour's red
 * channel carries the lens id, the shader picks the tint and reads the live intensity of the
 * matching SIG material (driven by nyc.ts every frame) through uniform getters. Saves five draw
 * calls per chunk over one material per lens.
 */
let sigMat: THREE.MeshStandardMaterial | null = null;
const SIG_ORDER = () => [SIG.aveR, SIG.aveY, SIG.aveG, SIG.stR, SIG.stY, SIG.stG];
function signalLensMat() {
  if (sigMat) return sigMat;
  const m = new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, emissive: new THREE.Color('#ffffff'), roughness: 0.2 });
  const uSig = { get value() { return SIG_ORDER().map((x) => x.emissiveIntensity); } };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uSig = uSig;
    sh.fragmentShader = 'uniform float uSig[6];\n' + sh.fragmentShader
      .replace('#include <color_fragment>', `
        int sid = int(vColor.r * 5.0 + 0.5);
        int lamp = sid - (sid / 3) * 3;
        vec3 sigTint = lamp == 0 ? vec3(1.0, 0.16, 0.1) : lamp == 1 ? vec3(1.0, 0.7, 0.1) : vec3(0.16, 1.0, 0.54);
        float sigI = 0.0;
        for (int i = 0; i < 6; i++) if (i == sid) sigI = uSig[i];
        diffuseColor.rgb = sigTint * 0.1;`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance = sigTint * sigI;');
  };
  m.customProgramCacheKey = () => 'nyc-sig-lens';
  return (sigMat = m);
}
function lensGeo(id: number) {
  return cachedGeo(`lens${id}`, () => {
    const g = new THREE.CylinderGeometry(0.1, 0.1, 0.02, 18).toNonIndexed();
    const n = g.getAttribute('position').count;
    const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) a[i * 3] = id / 5;
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return g;
  });
}

/** NYC signal head: federal-yellow housing, three 12" lenses with tunnel visors, front = +z */
function signalHead(axis: 'x' | 'z') {
  return kit(`sighead|${axis}`, (k) => {
    const Y = PM.signalYellow();
    const base = axis === 'z' ? 0 : 3;
    k.add(new RoundedBoxGeometry(0.34, 1.0, 0.24, 2, 0.03), Y, 0, 0.5, 0);
    const visorO = new THREE.CylinderGeometry(0.13, 0.13, 0.24, 14, 1, true, -Math.PI * 0.62, Math.PI * 1.24);
    const visorI = flipped(new THREE.CylinderGeometry(0.122, 0.122, 0.24, 14, 1, true, -Math.PI * 0.62, Math.PI * 1.24));
    const rim = new THREE.TorusGeometry(0.11, 0.012, 6, 18);
    [0.82, 0.5, 0.18].forEach((yy, i) => {
      k.add(lensGeo(base + i), signalLensMat(), 0, yy, 0.125, Math.PI / 2, 0, 0, 1, false);
      k.add(rim, PM.signalBlack(), 0, yy, 0.122, 0, 0, 0, 1, false);
      // visor axis along +z, open at the bottom
      k.add(visorO, Y, 0, yy, 0.24, Math.PI / 2, 0, 0);
      k.add(visorI, PM.signalBlack(), 0, yy, 0.24, Math.PI / 2, 0, 0, 1, false);
    });
    // mounting hub top and bottom
    k.add(new THREE.CylinderGeometry(0.04, 0.04, 0.12, 8), Y, 0, 1.05, 0);
    k.add(new THREE.CylinderGeometry(0.04, 0.04, 0.1, 8), Y, 0, -0.04, 0);
  });
}

/** pedestrian signal: yellow box with LED hand / walker face and a hood; front = +z */
function pedSignal(channel: 'ave' | 'st') {
  return kit(`ped|${channel}`, (k) => {
    const Y = PM.signalYellow();
    k.add(new RoundedBoxGeometry(0.4, 0.38, 0.2, 2, 0.02), Y, 0, 0, 0);
    k.add(plane(0.34, 0.32, region(channel === 'ave' ? 'ped' : 'pedSt')), propAtlasLit(), 0, 0.19, 0.101, 0, 0, 0, 1, false);
    // hood
    k.add(new THREE.BoxGeometry(0.4, 0.015, 0.12), Y, 0, 0.375, 0.16, -0.12);
    for (const s of [-1, 1]) k.add(new THREE.BoxGeometry(0.015, 0.36, 0.1), Y, s * 0.195, 0.19, 0.15);
    // clamshell bracket to the pole
    k.add(new THREE.BoxGeometry(0.08, 0.3, 0.16), PM.galvDark(), 0, 0.04, -0.18);
  });
}
function pushButton() {
  return kit('push', (k) => {
    k.add(new RoundedBoxGeometry(0.13, 0.2, 0.08, 2, 0.015), PM.signalYellow(), 0, 0, 0);
    k.add(plane(0.12, 0.19, region('pushBox')), propAtlas(), 0, 0.1, 0.041, 0, 0, 0, 1, false);
    k.add(new THREE.BoxGeometry(0.24, 0.32, 0.01), mat('#f2f2ee', { rough: 0.5 }), 0, 0.37, -0.005);
    k.add(plane(0.23, 0.31, region('pushSign')), propAtlas(), 0, 0.37, 0.001, 0, 0, 0, 1, false);
  });
}

/** shared NYC pole base: cast "shoe" with mouldings and a handhole door */
function poleBase(k: KitBuilder, m: THREE.Material, r = 0.2, h = 0.6) {
  k.add(new THREE.LatheGeometry([V(0, 0, 0), V(r, 0, 0), V(r, 0.05, 0), V(r * 0.88, 0.08, 0), V(r * 0.82, h * 0.72, 0), V(r * 0.7, h * 0.78, 0), V(r * 0.64, h * 0.9, 0), V(r * 0.56, h, 0), V(0, h, 0)].map((v) => new THREE.Vector2(v.x, v.y)), 16), m, 0, 0, 0);
  k.add(new RoundedBoxGeometry(0.14, 0.22, 0.03, 2, 0.01), m, 0, 0.32, r * 0.85);
}

/** corner pole: galvanised shaft, two side-mounted heads, a mast arm, ped signals, push buttons */
export function signalPole(parent: THREE.Object3D, x: number, z: number, sx: number, sz: number) {
  const H = 6.2;
  const pole = kit('sigpole', (k) => {
    const G = PM.galv();
    poleBase(k, G, 0.22, 0.65);
    const shaft = new THREE.CylinderGeometry(0.085, 0.115, H - 0.6, 14);
    shaft.translate(0, (H - 0.6) / 2 + 0.6, 0);
    k.add(shaft, G);
    k.add(new THREE.SphereGeometry(0.1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), G, 0, H, 0);
    // sign bracket on top (for the street-name signs)
    k.add(new THREE.CylinderGeometry(0.03, 0.03, 0.75, 8), G, 0, H + 0.36, 0);
    // banding clamps
    for (const y of [2.5, 3.4, 4.4, 5.4]) k.add(new THREE.CylinderGeometry(0.118, 0.118, 0.05, 14), PM.galvDark(), 0, y, 0);
  });
  place(parent, pole, x, CURB, z);
  // mast arm over one roadway (alternating), heads hang from it facing that traffic
  const overAve = sx * sz > 0;
  const armLen = overAve ? 5.4 : 4.2;
  const arm = kit(`sigarm|${armLen}`, (k) => {
    const G = PM.galv();
    const a = new THREE.CylinderGeometry(0.05, 0.08, armLen, 10);
    a.rotateZ(-Math.PI / 2);
    a.translate(armLen / 2, 0, 0);
    k.add(a, G, 0, 5.6, 0, 0, 0, 0.02);
    // tie rod from the pole top to the outer third of the arm
    rod(k, V(0.05, 6.15, 0), V(armLen * 0.68, 5.62, 0), 0.014, G);
    k.add(new THREE.BoxGeometry(0.28, 0.3, 0.3), G, 0.1, 5.6, 0);
    // span hanger at the head
    k.add(new THREE.CylinderGeometry(0.02, 0.02, 0.3, 6), G, armLen - 0.4, 5.45, 0);
  });
  // local +x of the arm → road direction
  const armRy = overAve ? (sx > 0 ? 0 : Math.PI) : sz > 0 ? -Math.PI / 2 : Math.PI / 2;
  place(parent, arm, x, CURB, z, armRy);
  {
    const axis = overAve ? 'z' : 'x';
    const ry = axis === 'z' ? (sz > 0 ? 0 : Math.PI) : sx > 0 ? Math.PI / 2 : -Math.PI / 2;
    const d = armLen - 0.4;
    const hx = x + (overAve ? sx * d : 0), hz = z + (overAve ? 0 : sz * d);
    place(parent, signalHead(axis), hx, CURB + 4.25, hz, ry);
  }
  // side-mounted heads on the pole for both directions
  for (const axis of ['z', 'x'] as const) {
    const ry = axis === 'z' ? (sz > 0 ? 0 : Math.PI) : sx > 0 ? Math.PI / 2 : -Math.PI / 2;
    const ox = axis === 'x' ? 0 : -sx * 0.28, oz = axis === 'z' ? 0 : -sz * 0.28;
    place(parent, signalHead(axis), x + ox, CURB + 3.3, z + oz, ry);
    place(parent, kit('sidebracket', (k) => k.add(new THREE.BoxGeometry(0.06, 0.06, 0.3), PM.galvDark(), 0, 0, -0.15)), x + ox * 0.5, CURB + 3.8, z + oz * 0.5, ry);
  }
  // pedestrian signals face across both crosswalks; push buttons below
  // the face looking along z serves the crossing of the street (walk with avenue traffic)
  place(parent, pedSignal('ave'), x - sx * 0.0, CURB + 2.7, z + sz * 0.3, sz > 0 ? 0 : Math.PI);
  place(parent, pedSignal('st'), x + sx * 0.3, CURB + 2.7, z, sx > 0 ? Math.PI / 2 : -Math.PI / 2);
  place(parent, pushButton(), x - sx * 0.13, CURB + 1.05, z + sz * 0.1, sz > 0 ? 0 : Math.PI);
}

/** green NYC street-name sign (both faces), from the shared sign atlas; bake it with the chunk */
export const nameSignCache = new Map<string, THREE.BufferGeometry>();
export function nameSign(text: string, x: number, y: number, z: number, rotY: number) {
  const { mat: m, rect } = signSlot(text, 'street');
  let g = nameSignCache.get(text);
  if (!g) {
    g = new THREE.BoxGeometry(1.47, 0.23, 0.018);
    // all faces show the sign; edges get a sliver of the border colour
    toRect(g, rect);
    nameSignCache.set(text, g);
  }
  const s = new THREE.Mesh(g, m);
  s.position.set(x, y, z);
  s.rotation.y = rotY;
  s.castShadow = true;
  return s;
}

// ---------------------------------------------------------------- street lights

/**
 * NYC street light. 'cobra': galvanised tapered pole with a davit arm and an LED cobra-head;
 * 'crook': the black cast-iron Bishop's Crook of historic districts with a teardrop luminaire.
 * Arm reaches over the road: `axis` is the kerb's direction, `side` the road side.
 */
export function lampPost(parent: THREE.Object3D, group: THREE.Group, x: number, z: number, axis: 'x' | 'z', side: number, style: 'cobra' | 'crook' = 'cobra') {
  const ry = axis === 'x' ? (side > 0 ? -Math.PI / 2 : Math.PI / 2) : side > 0 ? 0 : Math.PI;
  place(parent, style === 'crook' ? crookLamp() : cobraLamp(), x, CURB, z, ry);
  // luminaire position for lighting.ts night lights
  const [lx, ly] = style === 'crook' ? [0.98, 3.85] : [2.95, 9.15];
  group.add(streetLightMarker(x + Math.cos(ry) * lx, CURB + ly, z - Math.sin(ry) * lx));
}

function cobraLamp() {
  return kit('lamp-cobra', (k) => {
    const G = PM.galv();
    poleBase(k, G, 0.2, 0.6);
    const H = 8.4;
    const shaft = new THREE.CylinderGeometry(0.06, 0.1, H - 0.55, 12);
    shaft.translate(0, (H - 0.55) / 2 + 0.55, 0);
    k.add(shaft, G);
    // davit arm: rises out of the pole top and sweeps over the road
    const arm = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([V(0, H - 0.4, 0), V(0, H + 0.2, 0), V(0.25, H + 0.65, 0), V(0.8, H + 0.85, 0), V(1.8, H + 0.9, 0), V(2.55, H + 0.88, 0)]), 28, 0.048, 8);
    k.add(arm, G);
    k.add(new THREE.SphereGeometry(0.065, 10, 6), G, 0, H + 0.02, 0);
    // LED cobra head: grey die-cast shell, flat lens underneath
    const hx = 2.95, hy = H + 0.82;
    const shell = new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2);
    k.add(shell, mat('#a6abad', { rough: 0.45, metal: 0.6 }), hx, hy, 0, 0, 0, 0, [0.46, 0.12, 0.2]);
    k.add(new THREE.CylinderGeometry(1, 1, 1, 20), mat('#8e9395', { rough: 0.5, metal: 0.6 }), hx, hy - 0.025, 0, 0, 0, 0, [0.46, 0.05, 0.2]);
    const lens = new THREE.CircleGeometry(1, 20);
    lens.rotateX(Math.PI / 2);
    k.add(lens, lampLens(), hx + 0.04, hy - 0.052, 0, 0, 0, 0, [0.36, 1, 0.15], false);
    // slip-fitter onto the arm
    k.add(new THREE.CylinderGeometry(0.06, 0.06, 0.25, 10), G, 2.55, hy + 0.06, 0, 0, 0, Math.PI / 2);
  });
}

function crookLamp() {
  return kit('lamp-crook', (k) => {
    const Bk = PM.black();
    // fluted cast-iron base
    const prof: [number, number][] = [[0, 0], [0.26, 0], [0.26, 0.06], [0.22, 0.1], [0.22, 0.17], [0.18, 0.22], [0.16, 0.6], [0.18, 0.64], [0.13, 0.72], [0.11, 1.0], [0.13, 1.05], [0.09, 1.12], [0.075, 1.25], [0, 1.25]];
    const base = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 24);
    const p = base.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      if (y > 0.22 && y < 0.6) {
        const a = Math.atan2(p.getZ(i), p.getX(i));
        const f = 1 + 0.06 * Math.max(0, Math.cos(a * 12));
        p.setX(i, p.getX(i) * f);
        p.setZ(i, p.getZ(i) * f);
      }
    }
    base.computeVertexNormals();
    k.add(base, Bk);
    const shaft = new THREE.CylinderGeometry(0.05, 0.07, 3.2, 12);
    shaft.translate(0, 1.25 + 1.6, 0);
    k.add(shaft, Bk);
    for (const y of [2.2, 4.3]) k.add(new THREE.TorusGeometry(0.065, 0.02, 6, 14), Bk, 0, y, 0, Math.PI / 2);
    k.add(new THREE.SphereGeometry(0.07, 10, 8), Bk, 0, 4.55, 0);
    k.add(new THREE.ConeGeometry(0.03, 0.18, 8), Bk, 0, 4.7, 0);
    // the crook and its scroll
    k.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([V(0, 4.3, 0), V(0.02, 4.75, 0), V(0.18, 5.0, 0), V(0.5, 5.06, 0), V(0.82, 4.96, 0), V(0.97, 4.78, 0), V(0.98, 4.6, 0)]), 32, 0.032, 8), Bk);
    k.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([V(0.04, 4.42, 0), V(0.3, 4.52, 0), V(0.5, 4.7, 0), V(0.45, 4.86, 0), V(0.32, 4.82, 0), V(0.33, 4.7, 0), V(0.4, 4.68, 0)]), 32, 0.014, 6), Bk);
    // teardrop luminaire hanging from the hook
    const lx = 0.98;
    k.add(new THREE.CylinderGeometry(0.02, 0.02, 0.12, 6), Bk, lx, 4.54, 0);
    const cap = new THREE.LatheGeometry([[0, 0.12], [0.05, 0.12], [0.08, 0.08], [0.2, -0.02], [0.23, -0.06], [0.21, -0.08], [0, -0.08]].map(([r, y]) => new THREE.Vector2(r, y)), 18);
    k.add(cap, Bk, lx, 4.38, 0);
    const glass = new THREE.LatheGeometry([[0, -0.08], [0.2, -0.08], [0.2, -0.2], [0.15, -0.36], [0.07, -0.47], [0, -0.5]].map(([r, y]) => new THREE.Vector2(r, y)), 18);
    k.add(glass, lampLens(), lx, 4.38, 0, 0, 0, 0, 1, false);
  });
}

// ---------------------------------------------------------------- hydrant

const HYDRANT_PAINT: [string, string][] = [
  ['#161616', '#b9bdbf'], ['#161616', '#b9bdbf'], ['#a8191b', '#a8191b'], ['#c9a019', '#c9a019'], ['#a8191b', '#dcdcd6'], ['#2d5a32', '#2d5a32'], ['#c9a019', '#161616'],
];
/** NYC hydrant (Mueller / "Corey" style): flanged base, barrel, domed bonnet, pentagon nut, two side outlets and a pumper */
export function hydrant(parent: THREE.Object3D, x: number, z: number, rng?: Rng, ry?: number) {
  const r = rng ?? new Rng(Math.round(x * 31 + z * 17));
  const [body, top] = r.pick(HYDRANT_PAINT);
  const parts = kit(`hydrant|${body}|${top}`, (k) => {
    const Bm = mat(body, { rough: 0.42, metal: 0.25 });
    const Tm = mat(top, { rough: top === '#b9bdbf' ? 0.35 : 0.42, metal: top === '#b9bdbf' ? 0.7 : 0.25 });
    const lath = (prof: number[][], m: THREE.Material) => k.add(new THREE.LatheGeometry(prof.map(([a, b]) => new THREE.Vector2(a, b)), 20), m);
    lath([[0, 0], [0.16, 0], [0.16, 0.03], [0.13, 0.045], [0.11, 0.06], [0.135, 0.07], [0.135, 0.1], [0.1, 0.115], [0.095, 0.13], [0.093, 0.48], [0.12, 0.49], [0.125, 0.515], [0, 0.515]], Bm);
    lath([[0, 0.515], [0.125, 0.515], [0.125, 0.54], [0.1, 0.555], [0.103, 0.6], [0.1, 0.65], [0.085, 0.695], [0.06, 0.725], [0.04, 0.74], [0, 0.745]], Tm);
    // flange bolts
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      k.add(new THREE.CylinderGeometry(0.012, 0.012, 0.03, 6), Tm, Math.cos(a) * 0.118, 0.53, Math.sin(a) * 0.118);
      k.add(new THREE.CylinderGeometry(0.01, 0.01, 0.025, 6), Bm, Math.cos(a) * 0.122, 0.105, Math.sin(a) * 0.122);
    }
    // pentagon operating nut
    k.add(new THREE.CylinderGeometry(0.028, 0.034, 0.045, 5), Tm, 0, 0.765, 0);
    // side outlets (2½") with caps and nuts; front pumper (4½")
    for (const s of [-1, 1]) {
      k.add(new THREE.CylinderGeometry(0.042, 0.048, 0.1, 14), Bm, s * 0.13, 0.4, 0, 0, 0, Math.PI / 2);
      k.add(new THREE.CylinderGeometry(0.05, 0.05, 0.035, 14), Tm, s * 0.19, 0.4, 0, 0, 0, Math.PI / 2);
      k.add(new THREE.CylinderGeometry(0.022, 0.022, 0.03, 5), Tm, s * 0.22, 0.4, 0, 0, 0, Math.PI / 2);
      // chain loop hanging from the cap
      k.add(new THREE.TorusGeometry(0.05, 0.004, 4, 12, Math.PI), mat('#3a3a3a', { rough: 0.5, metal: 0.8 }), s * 0.16, 0.36, 0.05, 0, 0, Math.PI);
    }
    k.add(new THREE.CylinderGeometry(0.06, 0.066, 0.08, 16), Bm, 0, 0.36, 0.125, Math.PI / 2);
    k.add(new THREE.CylinderGeometry(0.07, 0.07, 0.04, 16), Tm, 0, 0.36, 0.18, Math.PI / 2);
    k.add(new THREE.CylinderGeometry(0.026, 0.026, 0.035, 5), Tm, 0, 0.36, 0.21, Math.PI / 2);
  });
  place(parent, parts, x, CURB, z, ry ?? r.range(0, Math.PI * 2));
}

// ---------------------------------------------------------------- subway entrance

/**
 * Real stairwell below an entrance (local frame: opening x ∈ ±w/2, z ∈ ±l/2, open end at +z).
 * 14 risers of 18 cm / 28 cm treads with yellow nosings, tiled walls getting darker with depth,
 * handrails, a landing and a low passage running on under the closed end.
 */
function stairwell(k: KitBuilder, w: number, l: number) {
  const n = 14, rise = 0.18, run = 0.28;
  const bottom = -n * rise - CURB;
  const tile = mat('#c9c0a6', { rough: 0.35 }), tileLo = mat('#8a8270', { rough: 0.4 }), dark = mat('#2a2826', { rough: 0.8 });
  const conc = mat('#8d8a84', { rough: 0.9 }), nosing = mat('#d2a828', { rough: 0.6 });
  const iw = w - 0.06;
  for (let i = 0; i < n; i++) {
    const top = -(i + 1) * rise;
    const z1 = l / 2 - i * run, z0 = z1 - run;
    k.add(new THREE.BoxGeometry(iw, top - bottom, run), conc, 0, (top + bottom) / 2, (z0 + z1) / 2);
    k.add(new THREE.BoxGeometry(iw, 0.012, 0.05), nosing, 0, top + 0.006, z1 - 0.025, 0, 0, 0, 1, false);
  }
  const zl = l / 2 - n * run;
  const pass = 3.0; // passage length beyond the closed end
  // landing + passage floor
  k.add(new THREE.BoxGeometry(iw, 0.1, zl + l / 2 + pass), dark, 0, bottom - 0.05, (zl - l / 2 - pass) / 2);
  // side walls: upper (light tile) and lower (darker) bands
  const wallLen = l + pass;
  const wz = -pass / 2;
  const depth = -bottom;
  const split = 1.2;
  for (const sx of [-1, 1]) {
    k.add(new THREE.BoxGeometry(0.06, split, wallLen), tile, (sx * w) / 2, -split / 2, wz);
    k.add(new THREE.BoxGeometry(0.06, depth - split, wallLen), tileLo, (sx * w) / 2, -split - (depth - split) / 2, wz);
    // handrail following the stair slope
    const a = new THREE.Vector3((sx * (w / 2 - 0.08)), -0.15 + 0.9 - 0.18, l / 2 - 0.1);
    const b = new THREE.Vector3((sx * (w / 2 - 0.08)), -(n * rise) + 0.9, zl);
    rod(k, a, b, 0.022, mat('#9ea3a5', { rough: 0.3, metal: 0.9 }), 8);
  }
  // passage ceiling (under the sidewalk) and its end
  const ceil = bottom + 2.35;
  k.add(new THREE.BoxGeometry(w, -ceil - CURB + 0.02, pass), dark, 0, (ceil - CURB) / 2, -l / 2 - pass / 2);
  k.add(new THREE.BoxGeometry(w, ceil - bottom, 0.05), mat('#0a0a0a', { rough: 1 }), 0, (ceil + bottom) / 2, -l / 2 - pass);
  // face of the wall above the passage at the closed end
  k.add(new THREE.BoxGeometry(iw, -ceil, 0.06), tile, 0, ceil / 2, -l / 2 + 0.03);
  // riser below the first tread at the open end
  k.add(new THREE.BoxGeometry(iw, rise + CURB, 0.06), conc, 0, -(rise + CURB) / 2 + 0.001, l / 2 + 0.03);
}

/** replace a horizontal plane mesh's geometry with the same rectangle minus a rectangular hole (chunk coords) */
function cutHole(mesh: THREE.Mesh, W: number, H: number, uvScale: (x: number, y: number) => [number, number], hx0: number, hx1: number, hz0: number, hz1: number) {
  const outer = new THREE.Shape([new THREE.Vector2(-W / 2, -H / 2), new THREE.Vector2(W / 2, -H / 2), new THREE.Vector2(W / 2, H / 2), new THREE.Vector2(-W / 2, H / 2)]);
  // mesh is rotated -90° about x: local y = -world z
  outer.holes.push(new THREE.Path([new THREE.Vector2(hx0, -hz1), new THREE.Vector2(hx0, -hz0), new THREE.Vector2(hx1, -hz0), new THREE.Vector2(hx1, -hz1)]));
  const g = new THREE.ShapeGeometry(outer);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, ...uvScale(pos.getX(i), pos.getY(i)));
  mesh.geometry.dispose();
  mesh.geometry = g;
}

/** stair entrance: dark-green railings with balusters and finials, globe lamps, black station sign */
export function subway(parent: THREE.Object3D, group: THREE.Group, x: number, z: number, cz: number, rng: Rng) {
  const w = 2.0, l = 5.0;
  const ry = Math.sign(z) > 0 ? 0 : Math.PI;
  const rail = kit('subway-rail', (k) => {
    const Gm = mat('#1d3f2b', { rough: 0.5, metal: 0.5 });
    const H = 1.07;
    const side = (len: number, cx: number, cz: number, alongZ: boolean) => {
      const ryy = alongZ ? Math.PI / 2 : 0;
      k.add(new THREE.BoxGeometry(len, 0.05, 0.07), Gm, cx, H, cz, 0, ryy);
      k.add(new THREE.BoxGeometry(len, 0.04, 0.04), Gm, cx, 0.14, cz, 0, ryy);
      k.add(new THREE.BoxGeometry(len, 0.03, 0.03), Gm, cx, 0.88, cz, 0, ryy);
      const n = Math.round(len / 0.11);
      for (let i = 1; i < n; i++) {
        const t = -len / 2 + (i * len) / n;
        k.add(new THREE.BoxGeometry(0.018, H - 0.14, 0.018), Gm, cx + (alongZ ? 0 : t), 0.14 + (H - 0.14) / 2, cz + (alongZ ? t : 0));
      }
      // decorative rings between the upper rails
      const m2 = Math.round(len / 0.22);
      for (let i = 0; i < m2; i++) {
        const t = -len / 2 + ((i + 0.5) * len) / m2;
        k.add(new THREE.TorusGeometry(0.075, 0.009, 4, 12), Gm, cx + (alongZ ? 0 : t), 0.975, cz + (alongZ ? t : 0), 0, alongZ ? Math.PI / 2 : 0);
      }
    };
    side(l, -w / 2, 0, true);
    side(l, w / 2, 0, true);
    side(w, 0, -l / 2, false);
    // newel posts with finials
    for (const [px, pz] of [[-w / 2, -l / 2], [w / 2, -l / 2], [-w / 2, 0], [w / 2, 0]]) {
      k.add(new THREE.BoxGeometry(0.09, H + 0.05, 0.09), Gm, px, (H + 0.05) / 2, pz);
      k.add(new THREE.SphereGeometry(0.06, 10, 8), Gm, px, H + 0.1, pz);
    }
    // globe lamp posts at the open end
    for (const s of [-1, 1]) {
      const px = (s * w) / 2, pz = l / 2;
      k.add(new THREE.LatheGeometry([[0, 0], [0.13, 0], [0.13, 0.08], [0.09, 0.14], [0.07, 0.5], [0.09, 0.55], [0.05, 0.62], [0, 0.62]].map(([a, b]) => new THREE.Vector2(a, b)), 14), Gm, px, 0, pz);
      k.add(new THREE.CylinderGeometry(0.038, 0.045, 1.75, 10), Gm, px, 0.62 + 0.875, pz);
      k.add(new THREE.CylinderGeometry(0.08, 0.06, 0.08, 12), Gm, px, 2.4, pz);
      k.add(tinted(new THREE.SphereGeometry(0.21, 18, 12), '#5cf08c'), glowVC(), px, 2.62, pz, 0, 0, 0, 1, false);
      k.add(new THREE.SphereGeometry(0.06, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), Gm, px, 2.81, pz);
      // last baluster run to the post
      k.add(new THREE.BoxGeometry(0.05, 0.05, 0.07), Gm, px, H, pz - 0.03);
    }
    // the stairwell itself: steps down from the open end to a landing and a passage under the sidewalk
    stairwell(k, w, l);
    // granite kerb around the opening
    for (const s of [-1, 1]) k.add(new THREE.BoxGeometry(0.12, 0.04, l), PM.granite(), (s * w) / 2, 0.02, 0, 0, 0, 0, 1, false);
  });
  place(parent, rail, x, CURB, z, ry);
  // open the sidewalk and the road plane under it so the stairwell is really there
  const hx0 = x - w / 2 + 0.03, hx1 = x + w / 2 - 0.03, hz0 = z - l / 2 + 0.03, hz1 = z + l / 2 - 0.03;
  const isPlane = (o: THREE.Object3D, W: number, H: number) => {
    const g = (o as THREE.Mesh).geometry as THREE.PlaneGeometry | undefined;
    return !!g && g.type === 'PlaneGeometry' && Math.abs(g.parameters.width - W) < 1e-3 && Math.abs(g.parameters.height - H) < 1e-3;
  };
  const sw = parent.children.find((o) => isPlane(o, BX * 2, BZ * 2)) as THREE.Mesh | undefined;
  if (sw) cutHole(sw, BX * 2, BZ * 2, (u, v) => [(u + BX) / 3, (v + BZ) / 3], hx0, hx1, hz0, hz1);
  const road = group.children.find((o) => isPlane(o, AX, SZ)) as THREE.Mesh | undefined;
  if (road) cutHole(road, AX, SZ, (u, v) => [u / AX + 0.5, v / SZ + 0.5], hx0, hx1, hz0, hz1);
  // station sign between the globe posts (both faces)
  const lines = rng.pick(['1 2 3', 'A C E', 'N Q R W', '4 5 6', 'B D F M', 'L', '7', 'J Z', 'G']);
  const { mat: sm, rect } = signSlot(`${streetName(cz)}|${lines}`, 'subway');
  const sg = toRect(new THREE.BoxGeometry(w - 0.08, 0.31, 0.03), rect);
  const s = new THREE.Mesh(sg, sm);
  s.position.set(x, CURB + 2.15, z + (Math.sign(z) * l) / 2);
  s.rotation.y = ry;
  parent.add(s);
  for (const sx of [-1, 1]) group.add(glow('#5aff8a', 1.2, x + (sx * w) / 2, CURB + 2.62, z + (Math.sign(z) * l) / 2, 0.5));
}

// ---------------------------------------------------------------- litter basket, mailbox, meters, news boxes

/** classic NYC wire litter basket, dark green, with a black liner bag */
export function litterBasket(parent: THREE.Object3D, x: number, z: number, ry = 0) {
  const parts = kit('litter', (k) => {
    const Gm = PM.dotGreen();
    const H = 0.84;
    const wall = new THREE.CylinderGeometry(0.29, 0.25, H - 0.06, 24, 1, true);
    const uv = wall.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 14, uv.getY(i) * 7);
    k.add(wall, wireMesh(), 0, 0.06 + (H - 0.06) / 2, 0);
    for (const [y, r] of [[H, 0.292], [0.62, 0.28], [0.35, 0.268], [0.07, 0.252]]) k.add(new THREE.TorusGeometry(r, 0.014, 6, 28), Gm, 0, y, 0, Math.PI / 2);
    k.add(new THREE.CylinderGeometry(0.25, 0.25, 0.02, 20), Gm, 0, 0.06, 0);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      k.add(new THREE.BoxGeometry(0.025, H, 0.012), Gm, Math.cos(a) * 0.272, H / 2 + 0.02, Math.sin(a) * 0.272, 0, -a, -0.045);
    }
    // liner bag: black plastic folded over the rim
    const bag = mat('#0d0d0e', { rough: 0.3 });
    k.add(new THREE.CylinderGeometry(0.255, 0.22, 0.7, 16, 1, true), bag, 0, 0.45, 0);
    const lump = new THREE.IcosahedronGeometry(0.26, 2);
    const p = lump.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const s = 1 + 0.12 * Math.sin(p.getX(i) * 31) * Math.sin(p.getZ(i) * 27 + p.getY(i) * 13);
      p.setXYZ(i, p.getX(i) * s, Math.max(-0.02, p.getY(i)) * 0.55 * s, p.getZ(i) * s);
    }
    lump.computeVertexNormals();
    k.add(lump, bag, 0, H - 0.07, 0);
  });
  place(parent, parts, x, CURB, z, ry);
}

/** USPS-style blue collection box: legs, domed top, pull-down chute, decals */
export function mailbox(parent: THREE.Object3D, x: number, z: number, ry = 0) {
  const parts = kit('mailbox', (k) => {
    const Bl = mat('#1d3f8a', { rough: 0.45, metal: 0.35 });
    const W = 0.53, D = 0.48, H = 0.95, leg = 0.3;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.add(new THREE.BoxGeometry(0.05, leg, 0.05), Bl, (sx * (W - 0.06)) / 2, leg / 2, (sz * (D - 0.06)) / 2);
    k.add(new RoundedBoxGeometry(W, H, D, 2, 0.015), Bl, 0, leg + H / 2, 0);
    const dome = new THREE.CylinderGeometry(W / 2, W / 2, D, 24, 1, false, -Math.PI / 2, Math.PI);
    k.add(dome, Bl, 0, leg + H, 0, Math.PI / 2, 0, 0);
    // chute handle and hood
    k.add(new THREE.BoxGeometry(W * 0.75, 0.13, 0.05), Bl, 0, leg + H + 0.06, D / 2 + 0.015, -0.35);
    k.add(new THREE.BoxGeometry(0.2, 0.025, 0.035), mat('#c8ccd0', { rough: 0.35, metal: 0.9 }), 0, leg + H + 0.0, D / 2 + 0.05);
    const decal = region('mailFront');
    k.add(plane(W - 0.04, H - 0.18, decal), propAtlas(), 0, leg + H / 2 - 0.05, D / 2 + 0.002, 0, 0, 0, 1, false);
    for (const s of [-1, 1]) k.add(plane(D - 0.04, H - 0.18, decal), propAtlas(), (s * W) / 2 + s * 0.002, leg + H / 2 - 0.05, 0, 0, (s * Math.PI) / 2, 0, 1, false);
  });
  place(parent, parts, x, CURB, z, ry);
}

/** parking pay station ("Muni-Meter"): pedestal, head with face, solar panel */
export function muniMeter(parent: THREE.Object3D, x: number, z: number, ry = 0) {
  const parts = kit('muni', (k) => {
    const Gr = mat('#3c4044', { rough: 0.45, metal: 0.6 });
    k.add(new THREE.BoxGeometry(0.42, 0.03, 0.34), Gr, 0, 0.015, 0);
    k.add(new RoundedBoxGeometry(0.3, 1.0, 0.22, 2, 0.02), Gr, 0, 0.5, 0);
    k.add(new RoundedBoxGeometry(0.36, 0.62, 0.28, 2, 0.03), Gr, 0, 1.3, 0);
    k.add(plane(0.3, 0.56, region('muni')), propAtlas(), 0, 1.3, 0.141, 0, 0, 0, 1, false);
    k.add(new THREE.BoxGeometry(0.36, 0.02, 0.3), mat('#16233a', { rough: 0.15, metal: 0.4 }), 0, 1.66, 0, -0.35);
    k.add(new THREE.BoxGeometry(0.4, 0.05, 0.32), Gr, 0, 1.625, 0);
  });
  place(parent, parts, x, CURB, z, ry);
}

/** a row of coin-op / free newspaper boxes on pedestals */
export function newsBoxes(parent: THREE.Object3D, x: number, z: number, axis: 'x' | 'z', rng: Rng, facing = 1) {
  const n = rng.int(2, 4);
  const ry = axis === 'x' ? (facing > 0 ? 0 : Math.PI) : facing > 0 ? Math.PI / 2 : -Math.PI / 2;
  for (let i = 0; i < n; i++) {
    const v = rng.int(0, 4);
    const COL = ['#c8202a', '#1e4fa3', '#f0b400', '#f2f2ee', '#2a7a3a'][v];
    const parts = kit(`news|${v}`, (k) => {
      const Bm = mat(COL, { rough: 0.5, metal: 0.3 });
      const Gr = mat('#3a3c3e', { rough: 0.5, metal: 0.6 });
      k.add(new THREE.BoxGeometry(0.06, 0.45, 0.06), Gr, 0, 0.225, 0);
      k.add(new THREE.BoxGeometry(0.35, 0.03, 0.35), Gr, 0, 0.015, 0);
      k.add(new RoundedBoxGeometry(0.47, 0.55, 0.42, 2, 0.02), Bm, 0, 0.45 + 0.275, 0);
      k.add(new THREE.BoxGeometry(0.49, 0.04, 0.44), Bm, 0, 1.02, 0, 0.12);
      k.add(plane(0.43, 0.46, region(`news${v}` as Region)), propAtlas(), 0, 0.72, 0.212, 0, 0, 0, 1, false);
      k.add(new THREE.BoxGeometry(0.1, 0.12, 0.04), Gr, 0.14, 1.06, 0.12);
    });
    const t = (i - (n - 1) / 2) * 0.52;
    place(parent, parts, x + (axis === 'x' ? t : 0), CURB, z + (axis === 'z' ? t : 0), ry + rng.range(-0.06, 0.06));
  }
}

// ---------------------------------------------------------------- steam stack, manholes, bags

/** Con Edison orange-and-white steam chimney on its drum, with an arrow barricade */
export function steamStack(parent: THREE.Object3D, x: number, z: number, ry = 0) {
  const parts = kit('steamstack', (k) => {
    const Or = mat('#e8661a', { rough: 0.6 });
    const chim = new THREE.CylinderGeometry(0.3, 0.34, 3.2, 20, 1, true);
    toRect(chim, region('stack'));
    k.add(chim, propAtlas(), 0, 0.55 + 1.6, 0);
    k.add(flipped(new THREE.CylinderGeometry(0.29, 0.33, 3.2, 20, 1, true)), mat('#1a1614', { rough: 0.9 }), 0, 0.55 + 1.6, 0, 0, 0, 0, 1, false);
    k.add(new THREE.TorusGeometry(0.3, 0.025, 6, 20), mat('#f1efe8', { rough: 0.6 }), 0, 3.75, 0, Math.PI / 2);
    k.add(new THREE.CylinderGeometry(0.48, 0.52, 0.55, 20), Or, 0, 0.275, 0);
    k.add(new THREE.TorusGeometry(0.48, 0.03, 6, 20), Or, 0, 0.55, 0, Math.PI / 2);
    // barricade: A-frame with an arrow board
    const bx = 0.95;
    for (const s of [-1, 1]) {
      k.add(new THREE.BoxGeometry(0.05, 1.1, 0.05), Or, bx, 0.52, s * 0.55, 0.25);
      k.add(new THREE.BoxGeometry(0.05, 1.1, 0.05), Or, bx, 0.52, s * 0.55, -0.25);
    }
    k.add(new THREE.BoxGeometry(0.03, 0.32, 1.25), Or, bx, 0.9, 0);
    k.add(plane(1.22, 0.3, region('barricade')), propAtlas(), bx + 0.018, 0.9, 0, 0, Math.PI / 2, 0, 1, false);
    k.add(plane(1.22, 0.3, region('barricade')), propAtlas(), bx - 0.018, 0.9, 0, 0, -Math.PI / 2, 0, 1, false);
  });
  place(parent, parts, x, 0, z, ry);
}

/** cast-iron manhole cover flush with the asphalt */
export function manhole(parent: THREE.Object3D, x: number, z: number, kind = 0, ry = 0) {
  const parts = kit(`manhole|${kind}`, (k) => {
    const top = new THREE.CircleGeometry(0.38, 28);
    toRect(top, region(kind ? 'manholeB' : 'manhole'));
    top.rotateX(-Math.PI / 2);
    k.add(top, propAtlas(), 0, 0.012, 0, 0, 0, 0, 1, false);
    k.add(new THREE.CylinderGeometry(0.4, 0.41, 0.012, 28, 1, true), mat('#2a2826', { rough: 0.7, metal: 0.6 }), 0, 0.006, 0, 0, 0, 0, 1, false);
  });
  place(parent, parts, x, 0, z, ry);
}

/** a pile of black trash bags (and the odd clear recycling bag) put out on the kerb */
export function trashBags(parent: THREE.Object3D, x: number, z: number, rng: Rng) {
  const n = rng.int(3, 7);
  for (let i = 0; i < n; i++) {
    const v = rng.int(0, 3);
    const clear = rng.chance(0.2);
    const parts = kit(`bag|${v}|${clear}`, (k) => {
      const g = new THREE.IcosahedronGeometry(0.5, 3);
      const p = g.getAttribute('position') as THREE.BufferAttribute;
      const rr = new Rng(v * 7 + 1);
      const ph = [rr.range(0, 6), rr.range(0, 6), rr.range(0, 6)];
      for (let j = 0; j < p.count; j++) {
        const px = p.getX(j), py = p.getY(j), pz = p.getZ(j);
        let s = 1 + 0.08 * Math.sin(px * 7 + ph[0]) * Math.sin(pz * 6 + ph[1]) + 0.04 * Math.sin(py * 13 + ph[2]) + 0.012 * Math.sin(px * 31 + pz * 29);
        if (py < -0.25) s *= 0.9; // flattened bottom
        p.setXYZ(j, px * s, Math.max(-0.42, py) * s, pz * s);
      }
      g.computeVertexNormals();
      const m = clear ? mat('#5d7f9e', { rough: 0.2, metal: 0.1 }) : mat('#0e0e10', { rough: 0.25 });
      k.add(g, m, 0, 0.42 * 0.8, 0, 0, 0, 0, [0.72, 0.8, 0.66]);
      // knot
      k.add(new THREE.ConeGeometry(0.06, 0.12, 7), m, 0.0, 0.76, 0, 0.1, 0, 0.1);
    });
    const a = rng.range(0, 6.28), d = rng.range(0, 0.6);
    const s = rng.range(0.7, 1.05);
    place(parent, parts, x + Math.cos(a) * d, CURB, z + Math.sin(a) * d, rng.range(0, 6.28), [s, s * rng.range(0.85, 1.1), s]);
  }
}

// ---------------------------------------------------------------- rarer furniture: bus shelter, newsstand, bike share, sidewalk shed

let glassMat: THREE.MeshStandardMaterial | null = null;
function shelterGlass() {
  return (glassMat ??= new THREE.MeshStandardMaterial({ color: '#b8ccd2', transparent: true, opacity: 0.28, roughness: 0.05, metalness: 0.1, depthWrite: false }));
}

/** bus stop shelter: brushed aluminium frame, glass back and side, lit ad panel, bench; front = +z */
export function busShelter(parent: THREE.Object3D, x: number, z: number, ry: number) {
  const parts = kit('busshelter', (k) => {
    const Al = mat('#a9aeb1', { rough: 0.35, metal: 0.85 });
    const L = 4.0, D = 1.45, H = 2.45;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.add(new RoundedBoxGeometry(0.08, H, 0.08, 2, 0.015), Al, (sx * L) / 2, H / 2, (sz * D) / 2 - 0.05);
    k.add(new RoundedBoxGeometry(L + 0.25, 0.12, D + 0.3, 2, 0.03), Al, 0, H + 0.04, 0.05, -0.03);
    k.add(new THREE.BoxGeometry(L, 0.06, 0.06), Al, 0, 0.25, -D / 2 - 0.05);
    k.add(new THREE.BoxGeometry(L, 0.06, 0.06), Al, 0, H - 0.06, -D / 2 - 0.05);
    k.add(new THREE.BoxGeometry(L - 0.1, H - 0.4, 0.012), shelterGlass(), 0, 0.25 + (H - 0.4) / 2, -D / 2 - 0.05, 0, 0, 0, 1, false);
    k.add(new THREE.BoxGeometry(0.012, H - 0.4, D - 0.1), shelterGlass(), -L / 2, 0.25 + (H - 0.4) / 2, -0.05, 0, 0, 0, 1, false);
    // ad box at the open end
    k.add(new RoundedBoxGeometry(0.22, 1.9, 1.35, 2, 0.03), Al, L / 2, 0.2 + 0.95, -0.05);
    for (const s of [-1, 1]) k.add(plane(1.2, 1.75, region('poster')), propAtlasLit(), L / 2 + s * 0.112, 0.2 + 0.95, -0.05, 0, (s * Math.PI) / 2, 0, 1, false);
    // bench
    k.add(new THREE.BoxGeometry(1.8, 0.05, 0.36), Al, -0.6, 0.45, -D / 2 + 0.2);
    for (const s of [-1, 1]) k.add(new THREE.BoxGeometry(0.05, 0.45, 0.3), Al, -0.6 + s * 0.8, 0.225, -D / 2 + 0.2);
  });
  place(parent, parts, x, CURB, z, ry);
  // bus stop sign pole
  const sign = kit('busstopsign', (k) => {
    k.add(new THREE.CylinderGeometry(0.035, 0.035, 2.9, 8), PM.galv(), 0, 1.45, 0);
    k.add(new THREE.BoxGeometry(0.45, 0.6, 0.02), mat('#1e4fa3', { rough: 0.4 }), 0, 2.55, 0.04);
    k.add(new THREE.BoxGeometry(0.47, 0.2, 0.025), mat('#f2f2ee', { rough: 0.4 }), 0, 2.12, 0.04);
    k.add(new THREE.BoxGeometry(0.2, 0.55, 0.12), mat('#3a3c3e', { rough: 0.5, metal: 0.5 }), 0, 1.5, 0.08);
  });
  const c = Math.cos(ry), s = Math.sin(ry);
  place(parent, sign, x + c * 2.6, CURB, z - s * 2.6, ry);
}

/** sidewalk newsstand kiosk: green-grey steel box, open front with magazines, awning */
export function newsstand(parent: THREE.Object3D, x: number, z: number, ry: number) {
  const parts = kit('newsstand', (k) => {
    const Gm = mat('#4c5a52', { rough: 0.5, metal: 0.5 });
    const L = 3.0, D = 1.6, H = 2.5;
    k.add(new RoundedBoxGeometry(L, H, D, 2, 0.03), Gm, 0, H / 2, 0);
    k.add(new THREE.BoxGeometry(L + 0.2, 0.08, D + 0.25), Gm, 0, H + 0.04, 0.1);
    // display front
    k.add(plane(L - 0.2, 1.2, region('magazines')), propAtlas(), 0, 1.25, D / 2 + 0.003, 0, 0, 0, 1, false);
    k.add(new THREE.BoxGeometry(L - 0.1, 0.35, 0.3), Gm, 0, 0.45, D / 2 + 0.15);
    k.add(plane(L - 0.2, 0.25, region('magazines')), propAtlas(), 0, 0.82, D / 2 + 0.16, -Math.PI / 2 + 0.3, 0, 0, 1, false);
    // awning
    k.add(new THREE.BoxGeometry(L + 0.1, 0.03, 0.7), mat('#1e5a3a', { rough: 0.7 }), 0, 2.15, D / 2 + 0.3, 0.3);
    for (const s of [-1, 1]) k.add(plane(1.2, 1.7, region('poster2')), propAtlas(), (s * L) / 2 + s * 0.003, 1.3, 0, 0, (s * Math.PI) / 2, 0, 1, false);
    k.add(new THREE.BoxGeometry(L - 0.4, 0.3, 0.02), mat('#f2f2ee', { rough: 0.5 }), 0, 2.32, D / 2 + 0.01);
  });
  place(parent, parts, x, CURB, z, ry);
}

/** blue bike-share dock: base plate, docks, kiosk, and bikes; along +x from (x,z), docks face +z */
export function bikeDock(parent: THREE.Object3D, x: number, z: number, ry: number, n: number, rng: Rng) {
  const dock = kit('bikedock', (k) => {
    const Gr = mat('#8d9295', { rough: 0.4, metal: 0.8 });
    k.add(new THREE.BoxGeometry(0.85, 0.03, 0.75), mat('#5f6466', { rough: 0.7, metal: 0.5 }), 0, 0.015, 0);
    k.add(new RoundedBoxGeometry(0.16, 0.85, 0.24, 2, 0.04), Gr, 0, 0.03 + 0.425, -0.22, -0.08);
    k.add(new THREE.BoxGeometry(0.1, 0.06, 0.02), mat('#3ccf4a', { rough: 0.3 }), 0, 0.78, -0.09, -0.08, 0, 0, 1, false);
  });
  const bike = kit('bike', (k) => {
    const Bl = mat('#1b6fd0', { rough: 0.4, metal: 0.3 });
    const Tk = mat('#151515', { rough: 0.8 });
    const wheel = new THREE.TorusGeometry(0.31, 0.028, 6, 26);
    for (const zz of [-0.52, 0.52]) {
      k.add(wheel, Tk, 0, 0.34, zz, 0, Math.PI / 2);
      k.add(new THREE.CylinderGeometry(0.06, 0.06, 0.1, 10), Bl, 0, 0.34, zz, 0, 0, Math.PI / 2);
      k.add(new THREE.TorusGeometry(0.29, 0.006, 3, 10), mat('#bbb', { metal: 0.9, rough: 0.3 }), 0, 0.34, zz, 0, Math.PI / 2);
    }
    // step-through frame
    k.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([V(0, 0.34, -0.52), V(0, 0.42, -0.2), V(0, 0.4, 0.15), V(0, 0.75, 0.4), V(0, 1.0, 0.45)]), 20, 0.035, 6), Bl);
    k.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([V(0, 0.42, -0.2), V(0, 0.7, -0.22), V(0, 0.9, -0.24)]), 8, 0.032, 6), Bl);
    k.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([V(0, 0.34, 0.52), V(0, 0.7, 0.47), V(0, 1.0, 0.45)]), 10, 0.025, 6), Bl);
    // saddle, bars, basket, fenders
    k.add(new RoundedBoxGeometry(0.16, 0.06, 0.26, 2, 0.025), Tk, 0, 0.93, -0.26);
    k.add(new THREE.CylinderGeometry(0.014, 0.014, 0.58, 6), Tk, 0, 1.06, 0.4, 0, 0, Math.PI / 2);
    k.add(new THREE.BoxGeometry(0.34, 0.2, 0.26), Bl, 0, 0.92, 0.62);
    for (const zz of [-0.52, 0.52]) k.add(new THREE.TorusGeometry(0.34, 0.03, 4, 12, Math.PI * 0.7), mat('#d8dadc', { rough: 0.4 }), 0, 0.34, zz, 0, Math.PI / 2, Math.PI * 0.15);
  });
  const kiosk = kit('bikekiosk', (k) => {
    const Gr = mat('#8d9295', { rough: 0.4, metal: 0.8 });
    k.add(new RoundedBoxGeometry(0.5, 1.8, 0.35, 2, 0.04), Gr, 0, 0.9, 0);
    k.add(plane(0.44, 1.2, region('bikePanel')), propAtlas(), 0, 1.05, 0.177, 0, 0, 0, 1, false);
    k.add(new THREE.BoxGeometry(0.6, 0.03, 0.5), mat('#16233a', { rough: 0.15, metal: 0.4 }), 0, 1.9, 0, -0.3);
  });
  const c = Math.cos(ry), s = Math.sin(ry);
  for (let i = 0; i <= n; i++) {
    const px = x + c * i * 0.85, pz = z - s * i * 0.85;
    if (i === n) {
      place(parent, kiosk, px, CURB, pz, ry);
      break;
    }
    place(parent, dock, px, CURB, pz, ry);
    if (rng.chance(0.75)) place(parent, bike, px, CURB, pz + 0, ry);
  }
}

/** sidewalk shed (scaffold bridge): green plywood deck and parapet on white steel pipes; runs along +x, depth toward +z */
export function sidewalkShed(parent: THREE.Object3D, x: number, z: number, ry: number, len: number) {
  const bays = Math.max(2, Math.round(len / 2.4));
  const bay = len / bays;
  const D = 2.6, H = 2.9;
  const part = kit(`shedbay|${bay.toFixed(2)}`, (k) => {
    const Wp = mat('#e8e8e2', { rough: 0.5, metal: 0.4 });
    const Gp = mat('#2f4a3a', { rough: 0.8 });
    const post = new THREE.CylinderGeometry(0.05, 0.05, H, 8);
    for (const zz of [0.25, D]) {
      k.add(post, Wp, 0, H / 2, zz);
      k.add(new THREE.BoxGeometry(0.22, 0.02, 0.22), Wp, 0, 0.01, zz);
    }
    // beams
    k.add(new THREE.BoxGeometry(0.1, 0.22, D), Wp, 0, H + 0.11, D / 2 + 0.12);
    k.add(new THREE.BoxGeometry(bay, 0.18, 0.1), Wp, bay / 2, H + 0.09, D);
    k.add(new THREE.BoxGeometry(bay, 0.18, 0.1), Wp, bay / 2, H + 0.09, 0.25);
    // diagonal brace
    k.add(new THREE.CylinderGeometry(0.025, 0.025, Math.hypot(bay, 1.2), 6), Wp, bay / 2, H - 0.6, D, 0, 0, Math.atan2(bay, 1.2));
    // deck, parapet, under-lights
    const deck = new THREE.BoxGeometry(bay, 0.08, D + 0.3);
    toRect(deck, region('plywood'));
    k.add(deck, propAtlas(), bay / 2, H + 0.22, D / 2 + 0.12);
    const para = new THREE.BoxGeometry(bay, 0.95, 0.05);
    toRect(para, region('plywood'));
    k.add(para, propAtlas(), bay / 2, H + 0.26 + 0.47, D + 0.28);
    k.add(new THREE.BoxGeometry(bay, 0.05, 0.06), Gp, bay / 2, H + 1.2, D + 0.28);
    k.add(new THREE.BoxGeometry(0.4, 0.05, 0.1), lampLens(), bay / 2, H - 0.0, D / 2, 0, 0, 0, 1, false);
  });
  const c = Math.cos(ry), s = Math.sin(ry);
  for (let i = 0; i < bays; i++) {
    const t = -len / 2 + i * bay;
    place(parent, part, x + c * t, CURB, z - s * t, ry);
  }
  // closing posts at the far end
  const endPosts = kit('shedend', (k) => {
    const Wp = mat('#e8e8e2', { rough: 0.5, metal: 0.4 });
    for (const zz of [0.25, D]) k.add(new THREE.CylinderGeometry(0.05, 0.05, H, 8), Wp, 0, H / 2, zz);
    k.add(new THREE.BoxGeometry(0.1, 0.22, D), Wp, 0, H + 0.11, D / 2 + 0.12);
    k.add(plane(0.9, 0.22, region('shedSign')), propAtlas(), 0, H + 0.6, D + 0.31, 0, 0, 0, 1, false);
  });
  place(parent, endPosts, x + c * (len / 2), CURB, z - s * (len / 2), ry);
}

// ---------------------------------------------------------------- vehicles


// ---------------------------------------------------------------- bollards and standpipes

/** steel pipe bollard: black paint, domed cap, reflective band; 'steel' = stainless security bollard */
export function bollard(parent: THREE.Object3D, x: number, z: number, kind: 'black' | 'steel' = 'black') {
  const parts = kit(`bollard|${kind}`, (k) => {
    const m = kind === 'black' ? mat('#1b1c1e', { rough: 0.45, metal: 0.5 }) : mat('#b9bcbd', { rough: 0.28, metal: 0.95 });
    const r = kind === 'black' ? 0.11 : 0.14;
    const H = kind === 'black' ? 0.9 : 0.95;
    k.add(new THREE.LatheGeometry([[0, 0], [r + 0.02, 0], [r + 0.02, 0.02], [r, 0.04], [r, H - 0.06], [r + 0.012, H - 0.04], [r * 0.8, H], [r * 0.45, H + 0.04], [0, H + 0.05]].map(([a, b]) => new THREE.Vector2(a, b)), 16), m);
    k.add(new THREE.CylinderGeometry(r + 0.003, r + 0.003, 0.05, 16, 1, true), mat(kind === 'black' ? '#e8d24a' : '#2a2a2a', { rough: 0.35 }), 0, H - 0.2, 0, 0, 0, 0, 1, false);
  });
  place(parent, parts, x, CURB, z);
}

/** sidewalk Siamese standpipe connection by a building: a pipe rising to a Y with two capped inlets */
export function standpipe(parent: THREE.Object3D, x: number, z: number, ry: number, red = false) {
  const parts = kit(`standpipe|${red}`, (k) => {
    const m = red ? mat('#a8191b', { rough: 0.4, metal: 0.3 }) : mat('#c7c2b0', { rough: 0.3, metal: 0.9 });
    const cap = mat('#b8a26a', { rough: 0.35, metal: 0.9 });
    k.add(new THREE.CylinderGeometry(0.11, 0.12, 0.04, 16), m, 0, 0.02, 0);
    k.add(new THREE.CylinderGeometry(0.06, 0.065, 0.5, 14), m, 0, 0.29, 0);
    k.add(new THREE.SphereGeometry(0.085, 14, 10), m, 0, 0.58, 0);
    for (const s of [-1, 1]) {
      const a = s * 0.75;
      const dx = Math.sin(a) * 0.12, dy = Math.cos(a) * 0.12;
      k.add(new THREE.CylinderGeometry(0.045, 0.05, 0.16, 14), m, dx, 0.58 + dy * 0.6, 0.03, 0.5, 0, -a);
      k.add(new THREE.CylinderGeometry(0.06, 0.06, 0.045, 14), cap, dx * 1.7, 0.58 + dy * 1.2, 0.07, 0.5, 0, -a);
      k.add(new THREE.CylinderGeometry(0.022, 0.022, 0.05, 6), cap, dx * 2.0, 0.58 + dy * 1.42, 0.09, 0.5, 0, -a);
      k.add(new THREE.TorusGeometry(0.05, 0.004, 4, 10, Math.PI), mat('#4a4a48', { rough: 0.5, metal: 0.8 }), dx * 1.3, 0.5, 0.08, 0, 0, Math.PI);
    }
  });
  place(parent, parts, x, CURB, z, ry);
}

// ---------------------------------------------------------------- block furnishing

/**
 * The block's smaller furniture beyond lights, trees and signals: litter baskets and a mailbox at the
 * corners, parking pay stations, trash-bag piles, a bus shelter / newsstand / bike-share dock /
 * sidewalk shed on the avenues now and then, and manhole covers in the roadway. Everything is
 * placed only where it doesn't collide with what's already on the sidewalk.
 */
export function streetExtras(o: { stat: THREE.Object3D; rng: Rng; colliders: LRect[]; near: (x: number, z: number, d?: number) => boolean; village: boolean }) {
  const { stat, rng, colliders, near } = o;
  const free = (x: number, z: number, w: number, d: number, pad = 0.3) => {
    if (near(x, z, 2.0)) return false;
    const r = rect(x, z, w, d);
    return !colliders.some((c) => overlaps(c, r, pad));
  };
  const claim = (x: number, z: number, w: number, d: number) => colliders.push(rect(x, z, w, d));
  // corners: litter baskets, one mailbox
  const mailCorner = rng.chance(0.45) ? rng.int(0, 3) : -1;
  let ci = 0;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    if (rng.chance(0.6)) {
      const x = sx * (BX - 0.55), z = sz * (BZ - 2.6);
      if (free(x, z, 0.6, 0.6, 0.1)) { litterBasket(stat, x, z, rng.range(0, 6)); claim(x, z, 0.6, 0.6); }
    }
    if (ci++ === mailCorner) {
      const x = sx * (BX - 2.8), z = sz * (BZ - 0.6);
      if (free(x, z, 0.6, 0.6, 0.1)) { mailbox(stat, x, z, sz > 0 ? Math.PI : 0); claim(x, z, 0.6, 0.6); }
    }
  }
  // streets (along x): pay stations near the kerb, trash bags put out
  for (const sz of [-1, 1]) {
    const z = sz * (BZ - 0.45);
    for (const t of [-BX + 12, 0, BX - 12]) {
      const x = t + rng.range(-3, 3);
      if (rng.chance(0.7) && free(x, z, 0.45, 0.4, 0.15)) { muniMeter(stat, x, z, sz > 0 ? Math.PI : 0); claim(x, z, 0.4, 0.35); }
    }
    for (let k = rng.int(0, 2); k > 0; k--) {
      const x = rng.range(-BX + 6, BX - 6), zz = sz * (BZ - 1.0);
      if (free(x, zz, 1.6, 1.2, 0.1)) { trashBags(stat, x, zz, rng); claim(x, zz, 1.4, 1.0); }
    }
  }
  // avenues (along z): one of the rarer pieces per side, sometimes
  for (const sx of [-1, 1]) {
    const roll = rng.next();
    if (roll < 0.22) {
      const x = sx * (BX - 1.45), z = rng.range(-BZ + 7, BZ - 7);
      if (free(x, z, 1.6, 4.4)) { busShelter(stat, x, z, sx > 0 ? Math.PI / 2 : -Math.PI / 2); claim(x, z, 1.5, 4.1); }
    } else if (roll < 0.32) {
      const x = sx * (BX - 1.5), z = rng.chance(0.5) ? -BZ + 6 : BZ - 6;
      if (free(x, z, 1.8, 3.2)) { newsstand(stat, x, z, sx > 0 ? -Math.PI / 2 : Math.PI / 2); claim(x, z, 1.7, 3.1); }
    } else if (roll < 0.47) {
      const n = rng.int(5, 9), len = n * 0.85 + 0.5;
      const z0 = rng.range(-BZ + 5, BZ - 5 - len), x = sx * (BX - 0.75);
      if (free(x, z0 + len / 2, 0.9, len)) { bikeDock(stat, x, z0, -Math.PI / 2, n, rng); claim(x, z0 + len / 2, 0.85, len); }
    }
    if (!o.village && rng.chance(0.14)) {
      const len = rng.range(10, 22), z = rng.range(-BZ + 4 + len / 2, BZ - 4 - len / 2);
      sidewalkShed(stat, sx * (LX + 0.02), z, sx > 0 ? Math.PI / 2 : -Math.PI / 2, len);
    }
  }
  // pipe bollards guarding some corners; stainless security bollards in front of a few avenue buildings
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    if (!rng.chance(0.25)) continue;
    for (let k = 0; k < 3; k++) {
      const x = sx * (BX - 2.2 - k * 1.3), z = sz * (BZ - 0.35);
      if (free(x, z, 0.3, 0.3, 0.15)) { bollard(stat, x, z); claim(x, z, 0.26, 0.26); }
    }
  }
  for (const sx of [-1, 1]) {
    if (!rng.chance(0.12)) continue;
    const z0 = rng.range(-BZ + 5, BZ - 11);
    for (let k = 0; k < 6; k++) {
      const x = sx * (LX + 0.8), z = z0 + k * 1.3;
      if (free(x, z, 0.32, 0.32, 0.1)) { bollard(stat, x, z, 'steel'); claim(x, z, 0.3, 0.3); }
    }
  }
  // a standpipe or two against the building fronts
  for (let k = rng.int(1, 2); k > 0; k--) {
    const sz = rng.chance(0.5) ? 1 : -1;
    const x = rng.range(-LX + 4, LX - 4), z = sz * (LZ + 0.22);
    if (free(x, z, 0.4, 0.4, 0.1)) { standpipe(stat, x, z, sz > 0 ? 0 : Math.PI, rng.chance(0.3)); claim(x, z, 0.35, 0.35); }
  }
  // manhole covers in the roadway (this chunk's half of each road)
  for (let k = rng.int(2, 5); k > 0; k--) {
    if (rng.chance(0.5)) manhole(stat, rng.range(-BX, BX), (rng.chance(0.5) ? 1 : -1) * (BZ + rng.range(1.8, 4)), rng.int(0, 1), rng.range(0, 6));
    else manhole(stat, (rng.chance(0.5) ? 1 : -1) * (BX + rng.range(2, 7)), rng.range(-BZ, BZ), rng.int(0, 1), rng.range(0, 6));
  }
}
