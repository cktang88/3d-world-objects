import * as THREE from 'three';
import { enhance, glassFrom, materialKinds } from '../materials';
import { isOpen } from './open';
export { isOpen };

/**
 * A fixed set of shader programs for the museum. Each distinct material "shape" (type, defines, maps,
 * flags) is a shader program, and a new one met in a new room is compiled then: a hitch on a real
 * GPU. So museum exhibits are given consistent flags (museumLook / normalizeExhibit), and the
 * variants that remain (one per sand3d material kind, the common glTF map sets, the shell's own
 * materials) are built once as parked, never-drawn meshes in the atrium (prewarm), which main.ts
 * compiles on entering museum mode with everything else.
 *
 * Exhibits: front faces only (back faces culled, not shaded) unless authored double-sided and really
 * open (a leaf, a shell: isOpen) - one of the two fixed variants either way; no clearcoat, sheen or transmission (each an extra variant, and
 * transmission an extra render pass; glass becomes plain see-through); the UV scale folded into the
 * UVs (TRI_UVK always 1e+0). Tangents stay (big shared originals are not copied): the normal-mapped
 * sets are prewarmed with and without them.
 */
const looks = [new WeakMap<THREE.Material, THREE.Material>(), new WeakMap<THREE.Material, THREE.Material>()];

/** the glTF map slots every textured exhibit material is given (missing ones get a neutral 1x1) */
const FULL = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'] as const;
const neutral = new Map<string, THREE.DataTexture>();
/** a 1x1 texture that changes nothing in its slot: white albedo / roughness / metalness / AO / emissive, flat normal */
function neutralTex(slot: string) {
  let t = neutral.get(slot);
  if (!t) {
    t = new THREE.DataTexture(new Uint8Array(slot === 'normalMap' ? [128, 128, 255, 255] : [255, 255, 255, 255]), 1, 1);
    t.colorSpace = slot === 'map' || slot === 'emissiveMap' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.needsUpdate = true;
    neutral.set(slot, t);
  }
  return t;
}
const slots = (m: THREE.Material) => m as unknown as Record<string, THREE.Texture | null>;
/** textured but missing some of FULL (sand3d tri3 materials draw their own textures: left alone) */
function partial(m: THREE.MeshStandardMaterial) {
  if (m.customProgramCacheKey?.() === 'tri3') return false;
  const has = FULL.filter((k) => slots(m)[k]).length;
  return has > 0 && has < FULL.length;
}

function cloneLook(s: THREE.MeshStandardMaterial) {
  const c = s.clone();
  c.defines = { ...(s.defines ?? {}) };
  c.onBeforeCompile = s.onBeforeCompile;
  c.customProgramCacheKey = s.customProgramCacheKey;
  c.userData = { ...s.userData };
  return c;
}

/**
 * The museum version of an exhibit material, front-sided or double-sided (cached per material and
 * side; the input is not changed).
 */
export function museumLook(m0: THREE.Material, double = false): THREE.Material {
  // a museum look given again (a cached exhibit, a re-added model): start from its source
  const m = (m0.userData.lookSrc as THREE.Material | undefined) ?? m0;
  const cache = looks[double ? 1 : 0];
  const done = cache.get(m);
  if (done) return done;
  const s = m as THREE.MeshPhysicalMaterial;
  if (!s.isMeshStandardMaterial) {
    cache.set(m, m);
    return m;
  }
  const phys = !!s.isMeshPhysicalMaterial;
  const uvk = s.defines?.TRI_UVK;
  const side = double ? THREE.DoubleSide : THREE.FrontSide;
  const needs = s.side !== side || (double && s.transparent && !s.forceSinglePass) || (phys && (s.clearcoat > 0 || s.sheen > 0 || s.transmission > 0)) || (uvk !== undefined && uvk !== '1e+0') || partial(s);
  if (!needs) {
    cache.set(m, m);
    return m;
  }
  const c = cloneLook(s) as THREE.MeshPhysicalMaterial;
  c.userData.lookSrc = m;
  c.side = side;
  if (phys) {
    c.clearcoat = 0;
    c.sheen = 0;
    if (s.transmission > 0) {
      c.transmission = 0;
      c.transparent = true;
      c.opacity = Math.min(c.opacity, 0.3);
      c.depthWrite = false;
    }
  }
  if (partial(c)) for (const k of FULL) if (!slots(c)[k]) slots(c)[k] = neutralTex(k);
  // see-through and double-sided: one pass (three would draw the back faces first, in a variant of their own)
  if (double && c.transparent) c.forceSinglePass = true;
  if (uvk !== undefined && uvk !== '1e+0') {
    c.userData.uvk = Number(uvk);
    c.defines!.TRI_UVK = '1e+0';
  }
  cache.set(m, c);
  return c;
}

/** exhibit meshes shown front-sided / double-sided, and ms spent on the openness check (window.__looks) */
export const sideStats = { front: 0, double: 0, ms: 0, max: 0 };
if (typeof window !== 'undefined') (window as unknown as { __looks: unknown }).__looks = sideStats;

/** museumLook on every mesh under root, with the UV scale it needs */
export function normalizeExhibit(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    const src = (mesh.material.userData.lookSrc as THREE.Material | undefined) ?? mesh.material;
    const t0 = performance.now();
    // authored double-sided: kept only if open. Small meshes are checked here; bigger ones stay as
    // authored until the zfix worker has checked them (zoff.ts swaps in the front-sided look)
    const g0 = mesh.geometry, n = g0.index ? g0.index.count : (g0.getAttribute('position')?.count ?? 0);
    const double = src.side === THREE.DoubleSide && (g0.userData.open !== undefined || n <= 9000 ? isOpen(g0) : true);
    const dt = performance.now() - t0;
    sideStats.ms += dt;
    sideStats.max = Math.max(sideStats.max, dt);
    sideStats[double ? 'double' : 'front']++;
    const mat = museumLook(src, double);
    mesh.material = mat;
    const k = mat.userData.uvk as number | undefined;
    const g = mesh.geometry;
    const scale = k !== undefined && k !== 1 && !!g.getAttribute('uv') && !g.userData.uvk;
    if (!scale) return;
    // the geometry may be shared with other users of the model (the city): change a copy
    const c = g.userData.museumOwned ? g : g.clone();
    c.userData.museumOwned = true;
    const uv = (c.getAttribute('uv') as THREE.BufferAttribute).clone();
    for (let i = 0; i < uv.array.length; i++) (uv.array as Float32Array)[i] *= k;
    c.setAttribute('uv', uv);
    c.userData.uvk = k;
    mesh.geometry = c;
  });
}

/**
 * A program signature, close to three's program cache key for the museum's one scene (same lights,
 * fog and environment): what makes two materials compile two programs.
 */
export function lookSignature(mesh: THREE.Mesh, m: THREE.Material): string {
  const s = m as THREE.MeshPhysicalMaterial & { [k: string]: unknown };
  const has = (k: string) => (s[k] ? 1 : 0);
  const g = mesh.geometry;
  const col = g?.getAttribute('color');
  const defs = Object.entries(s.defines ?? {}).sort().map(([a, b]) => `${a}=${b}`).join(';');
  return [
    s.type, defs, s.customProgramCacheKey?.() === 'tri3' ? 'tri3' : '', s.onBeforeCompile ? String(s.onBeforeCompile).length : 0,
    s.transparent ? 'T' : 'O', s.side, s.vertexColors ? (col?.itemSize === 4 ? 'vca' : 'vc') : '',
    has('map'), has('normalMap'), has('roughnessMap'), has('metalnessMap'), has('aoMap'), has('emissiveMap'), has('alphaMap'), has('bumpMap'), has('lightMap'),
    (s.alphaTest ?? 0) > 0 ? 'at' : '', (s.clearcoat ?? 0) > 0 ? 'cc' : '', (s.sheen ?? 0) > 0 ? 'sh' : '', (s.transmission ?? 0) > 0 ? 'tx' : '',
    s.normalMap && g?.getAttribute('tangent') ? 'tan' : '', s.flatShading ? 'flat' : '', s.toneMapped === false ? 'notone' : '', s.fog === false ? 'nofog' : '',
    (mesh as THREE.InstancedMesh).isInstancedMesh ? 'inst' : '', (mesh as THREE.SkinnedMesh).isSkinnedMesh ? 'skin' : '',
  ].join('|');
}

/** every program signature under root */
export function signatures(root: THREE.Object3D, into = new Set<string>()) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh && !(o as THREE.Points).isPoints) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if (m) into.add(lookSignature(mesh, m));
  });
  return into;
}

/**
 * The exhibit variants as parked meshes (far below the floor, never in view, so never drawn): compiled
 * with the room that holds them. One per distinct exhibit look: each sand3d kind with and without UVs
 * and bake, glass, and the usual glTF map sets.
 */
export function prewarm(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'museum-prewarm';
  g.position.set(0, -1e4, 0);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0.01, 0, 0, 0, 0.01, 0], 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute([1, 1, 1, 1, 1, 1, 1, 1, 1], 3));
  const mats: THREE.Material[] = [];
  const both = (m: THREE.Material) => mats.push(museumLook(m, false), museumLook(m, true));
  for (const kind of materialKinds())
    for (const uv of [false, true])
      for (const bake of [false, true]) {
        const base = new THREE.MeshStandardMaterial({ color: '#888888', side: THREE.DoubleSide });
        both(enhance(base, kind, uv, { bake }));
      }
  both(glassFrom(new THREE.MeshStandardMaterial({ color: '#ffffff' })));
  // glTF materials: the map sets seen on the rebuilt and Smithsonian models
  // glTF materials: plain or fully textured (museumLook fills the missing slots), standard or
  // physical, with or without vertex colours
  for (const Ctor of [THREE.MeshStandardMaterial, THREE.MeshPhysicalMaterial])
    for (const tex of [false, true])
      for (const vc of [false, true]) {
        const m = new Ctor({ side: THREE.DoubleSide, vertexColors: vc });
        if (tex) slots(m).map = neutralTex('map');
        both(m);
      }
  // a room seen through a doorway glows a little (base.ts previewFill: an emissive copy of each shell
  // material, its map as the emissive map): those variants of the shell's surface sets
  for (const set of [['map'], ['map', 'normalMap', 'roughnessMap'], ['map', 'normalMap', 'roughnessMap', 'aoMap'], ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']]) {
    for (const glow of [false, true]) {
      const m = new THREE.MeshStandardMaterial();
      for (const k of set) slots(m)[k] = neutralTex(k);
      if (glow) slots(m).emissiveMap = slots(m).map;
      mats.push(m);
    }
  }
  // the shell's see-through materials (case glass, label and glow planes) first met in later rooms
  mats.push(new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.1, depthWrite: false }));
  mats.push(new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
  const geoA = geo.clone();
  geoA.setAttribute('color', new THREE.Float32BufferAttribute([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 4));
  const geoT = geo.clone();
  geoT.setAttribute('tangent', new THREE.Float32BufferAttribute([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1], 4));
  const seen = new Set<string>();
  for (const m of mats)
    for (const gg of (m as THREE.MeshStandardMaterial).normalMap ? [geo, geoT] : m.vertexColors ? [geo, geoA] : [geo]) {
      const mesh = new THREE.Mesh(gg, m);
      const k = lookSignature(mesh, m);
      if (seen.has(k)) continue;
      seen.add(k);
      mesh.frustumCulled = true;
      mesh.userData.prewarm = true;
      g.add(mesh);
    }
  return g;
}
