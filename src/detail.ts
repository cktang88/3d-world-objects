import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { untilAborted } from './dispose';
import { addLods, lodTris } from './meshlod'; // mesh-simplification: screen-space LOD chains for heavy originals

/**
 * Original, textured Objaverse models. Every sand3d-objaverse object was rebuilt from one;
 * when you get close we stream the original from allenai/objaverse and swap it in, scaled
 * to the sand3d object's real-world size.
 */

let loader: GLTFLoader | null = null;
/** the shared GLB loader (Draco, KTX2 and Meshopt enabled) */
export function gltf() {
  return loader;
}
export let originalsEnabled = true;
export function setOriginals(v: boolean) {
  originalsEnabled = v;
}

let draco: DRACOLoader | null = null;
let ktx2: KTX2Loader | null = null;
/**
 * Every GLTFLoader in the app goes through here (qa: tests/originals-guard.test.ts greps for it): Meshopt and
 * Draco always, KTX2 once a renderer is known. A bare loader failed every meshopt-compressed vehicle and street
 * prop ("setMeshoptDecoder must be called before loading compressed files") and left placeholders.
 */
export function configureLoader(l: GLTFLoader) {
  draco ??= new DRACOLoader().setDecoderPath(`${import.meta.env.BASE_URL}libs/draco/`);
  l.setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
  if (ktx2) l.setKTX2Loader(ktx2);
  return l;
}
export function initDetail(renderer: THREE.WebGLRenderer) {
  const base = import.meta.env.BASE_URL;
  ktx2 = new KTX2Loader().setTranscoderPath(`${base}libs/basis/`).detectSupport(renderer);
  loader = configureLoader(new GLTFLoader());
  maxAniso = renderer.capabilities.getMaxAnisotropy();
}
let maxAniso = 8;

/**
 * [districts] transmissive glass (sand3d glass becomes MeshPhysicalMaterial transmission: 1) makes three render
 * the whole opaque scene a second time into its transmission target: at Music Row the auto row showroom
 * cars' windows took the main pass from ~750 to 1532 draw calls. Showcase models and originals get plain see-through glass.
 */
const plainGlass = new Map<string, THREE.MeshStandardMaterial>();
export function noTransmission(root: THREE.Object3D) {
  let n = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const swap = (m: THREE.Material) => {
      const pm = m as THREE.MeshPhysicalMaterial;
      if (!pm.isMeshPhysicalMaterial || !(pm.transmission > 0)) return m;
      n++;
      const key = pm.color.getHexString();
      let g = plainGlass.get(key);
      if (!g) plainGlass.set(key, (g = new THREE.MeshStandardMaterial({ name: 'showcase-glass', color: pm.color, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false, envMapIntensity: 1.2 })));
      return g;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
  });
  return n;
}

export function originalUrl(id: string, og: number) {
  const uid = id.replace(/^objaverse-/, '');
  return `https://huggingface.co/datasets/allenai/objaverse/resolve/main/glbs/000-${String(og).padStart(3, '0')}/${uid}.glb`;
}

const MAX_BYTES = 40e6;
/**
 * [districts] decoded texture budget per original (pixels, all images): GLTFLoader decodes every image at full size
 * before shrinkTextures() runs, outside the JS heap (an 8k map is 256 MB of bitmap). Several at once near the
 * LaGuardia aircraft crashed headless pages; models over this are skipped (the sand3d version stays).
 */
export const MAX_DECODE_PX = 24e6;
/** loads above this (bytes or decoded pixels) run one at a time */
const HEAVY_BYTES = 8e6, HEAVY_PX = 8e6;
let heavyBusy: Promise<void> = Promise.resolve();
/** texture size cap for originals swapped in for showcase / street objects */
export const ORIGINAL_TEX_MAX = 1024;

/** width x height of a PNG / JPEG / WebP from its header (0 when unknown, e.g. KTX2: GPU-compressed) */
export function imageDims(b: Uint8Array): [number, number] {
  const u16 = (i: number) => (b[i] << 8) | b[i + 1];
  if (b[0] === 0x89 && b[1] === 0x50) return [(b[16] << 24 | b[17] << 16 | b[18] << 8 | b[19]) >>> 0, (b[20] << 24 | b[21] << 16 | b[22] << 8 | b[23]) >>> 0];
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) { i++; continue; }
      const mk = b[i + 1];
      if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) return [u16(i + 7), u16(i + 5)];
      if (mk === 0xd8 || mk === 0x01 || (mk >= 0xd0 && mk <= 0xd7)) { i += 2; continue; }
      i += 2 + u16(i + 2);
    }
    return [0, 0];
  }
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) {
    const tag = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (tag === 'VP8 ') return [(b[26] | b[27] << 8) & 0x3fff, (b[28] | b[29] << 8) & 0x3fff];
    if (tag === 'VP8L') { const v = b[21] | b[22] << 8 | b[23] << 16 | b[24] << 24; return [(v & 0x3fff) + 1, ((v >> 14) & 0x3fff) + 1]; }
    if (tag === 'VP8X') return [1 + (b[24] | b[25] << 8 | b[26] << 16), 1 + (b[27] | b[28] << 8 | b[29] << 16)];
  }
  return [0, 0];
}

/** total decoded pixels of a GLB's embedded images (from their headers, nothing decoded) */
export function glbImagePixels(buf: ArrayBuffer): { px: number; max: number; images: number } {
  const dv = new DataView(buf);
  const out = { px: 0, max: 0, images: 0 };
  if (buf.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) return out; // 'glTF'
  const jsonLen = dv.getUint32(12, true);
  let json: { images?: { bufferView?: number }[]; bufferViews?: { byteOffset?: number; byteLength: number }[] };
  try {
    json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)));
  } catch {
    return out;
  }
  const binStart = 20 + jsonLen + 8;
  for (const im of json.images ?? []) {
    const bv = im.bufferView !== undefined ? json.bufferViews?.[im.bufferView] : undefined;
    if (!bv) continue;
    const off = binStart + (bv.byteOffset ?? 0);
    if (off + 32 > buf.byteLength) continue;
    const [w, h] = imageDims(new Uint8Array(buf, off, Math.min(bv.byteLength, 65536)));
    out.images++;
    out.px += w * h;
    out.max = Math.max(out.max, w, h);
  }
  return out;
}

const MAX_TRIS_EACH = 1_500_000;
/** total triangles of originals shown at once (proximity manager) */
const MAX_TRIS_TOTAL = 9_000_000;
let shownTris = 0;
const MAX_ACTIVE = 3;
let active = 0;
const waiting: { run: () => void; prio: number }[] = [];
function slot(prio: number) {
  return new Promise<void>((resolve) => {
    waiting.push({ run: resolve, prio });
    pumpSlots();
  });
}
function pumpSlots() {
  waiting.sort((a, b) => a.prio - b.prio);
  while (active < MAX_ACTIVE && waiting.length) {
    active++;
    waiting.shift()!.run();
  }
}
function release() {
  active--;
  pumpSlots();
}

interface Cached {
  scene: THREE.Group;
  size: THREE.Vector3; // native bbox size
  center: THREE.Vector3;
  minY: number;
  users: number;
  bytes: number;
  tris: number;
}
const cache = new Map<string, Promise<Cached | null>>();
const failed = new Set<string>();

/** downscale huge textures so a room of originals fits in GPU memory */
async function shrinkTextures(root: THREE.Object3D, max: number) {
  const seen = new Set<THREE.Texture>();
  const jobs: Promise<void>[] = [];
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[] | undefined;
    if (!m) return;
    for (const mt of Array.isArray(m) ? m : [m]) {
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap'] as const) {
        const t = mt[k];
        if (!t || seen.has(t)) continue;
        seen.add(t);
        t.anisotropy = maxAniso;
        const img = t.image as ImageBitmap | HTMLImageElement | undefined;
        if (!img || !('width' in img) || Math.max(img.width, img.height) <= max) continue;
        const s = max / Math.max(img.width, img.height);
        jobs.push(
          createImageBitmap(img as ImageBitmap, { resizeWidth: Math.round(img.width * s), resizeHeight: Math.round(img.height * s), resizeQuality: 'high' })
            .then((bm) => {
              (img as ImageBitmap).close?.();
              t.image = bm;
              t.needsUpdate = true;
            })
            .catch(() => {}),
        );
      }
    }
  });
  await Promise.all(jobs);
}

async function fetchOriginal(id: string, og: number, prio: number, texMax: number): Promise<Cached | null> {
  await slot(prio);
  try {
    const res = await fetch(originalUrl(id, og));
    if (!res.ok) return null;
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_BYTES) {
      res.body?.cancel();
      return null;
    }
    const buf = await res.arrayBuffer();
    // [districts] no content-length (chunked): check the size we got; then the decode budget
    if (buf.byteLength > MAX_BYTES) return null;
    const img = glbImagePixels(buf);
    if (img.px > MAX_DECODE_PX) return null;
    // heavy ones decode one at a time (their transient bitmaps are the memory spike)
    let done = () => {};
    if (buf.byteLength > HEAVY_BYTES || img.px > HEAVY_PX) {
      const prev = heavyBusy;
      heavyBusy = new Promise<void>((r) => (done = r));
      await prev;
    }
    let gltf;
    try {
      gltf = await loader!.parseAsync(buf, '');
      await shrinkTextures(gltf.scene, texMax);
    } finally {
      done();
    }
    const scene = gltf.scene;
    noTransmission(scene); // [districts] KHR_materials_transmission doubled the frame's draw calls
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(scene);
    if (box.isEmpty()) return null;
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mt of mats) {
          const sm = mt as THREE.MeshStandardMaterial;
          if (sm.transparent && sm.opacity > 0.98) sm.transparent = false;
          if (sm.map) sm.map.colorSpace = THREE.SRGBColorSpace;
        }
      }
    });
    // mesh-simplification: heavy originals (often 0.3-1.5M tris) get 25 % / 6 % levels switched by screen-space error
    await addLods(scene).catch(() => 0);
    const tris = lodTris(scene);
    return { scene, size: box.getSize(new THREE.Vector3()), center: box.getCenter(new THREE.Vector3()), minY: box.min.y, users: 0, bytes: buf.byteLength, tris };
  } catch {
    return null;
  } finally {
    release();
  }
}

/**
 * An original fitted to `fit` (the sand3d object's size in metres, Y-up, base at 0).
 * Resolves null when there is none, it is too big, or originals are off.
 */
export async function loadOriginal(id: string, og: number | undefined, fit: THREE.Vector3, opts: { prio?: number; texMax?: number; signal?: AbortSignal } = {}): Promise<THREE.Group | null> {
  // opts.signal: the caller is gone (a disposed level): resolve null at once; the fetch goes on for the cache
  if (opts.signal?.aborted) return null;
  if (!og || !originalsEnabled || !loader || failed.has(id)) return null;
  let p = cache.get(id);
  if (!p) {
    p = fetchOriginal(id, og, opts.prio ?? 0, opts.texMax ?? 2048);
    cache.set(id, p);
    trim();
  }
  const gone = Symbol();
  const c0 = await untilAborted(p, opts.signal, () => gone);
  if (c0 === gone) return null;
  const c = c0 as Cached | null;
  // trimmed (and disposed, its bitmaps closed) while we waited: load it afresh
  if (c && cache.get(id) !== p) return loadOriginal(id, og, fit, opts);
  if (!c || c.tris > MAX_TRIS_EACH) {
    failed.add(id);
    return null;
  }
  c.users++;
  // uniform scale from the largest dimension; the original shares the sand3d object's orientation
  const s = Math.max(fit.x, fit.y, fit.z) / Math.max(c.size.x, c.size.y, c.size.z, 1e-6);
  const inner = c.scene.clone(true);
  inner.position.set(-c.center.x, -c.minY, -c.center.z);
  const g = new THREE.Group();
  g.scale.setScalar(s);
  g.add(inner);
  g.userData.originalOf = id;
  return g;
}

/** Let go of an original; cached data stays until the cache is trimmed. */
export function releaseOriginal(g: THREE.Object3D) {
  const id = g.userData.originalOf as string | undefined;
  if (!id) return;
  delete g.userData.originalOf; // once per copy
  cache.get(id)?.then((c) => {
    if (c) c.users--;
    trim();
  });
}

const CACHE_MAX = 60;
function trim() {
  if (cache.size <= CACHE_MAX) return;
  for (const [id, p] of cache) {
    if (cache.size <= CACHE_MAX) break;
    p.then((c) => {
      if (c && c.users <= 0) {
        cache.delete(id);
        disposeDeep(c.scene);
      }
    });
  }
}

export function disposeDeep(o: THREE.Object3D) {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    for (const mt of Array.isArray(m.material) ? m.material : [m.material]) {
      for (const v of Object.values(mt))
        if (v instanceof THREE.Texture) {
          v.dispose();
          (v.image as ImageBitmap | undefined)?.close?.(); // decoded bitmaps live outside the JS heap
        }
      mt.dispose();
    }
  });
}

// ---------------------------------------------------------------------------
// Proximity manager: sand3d objects near the player get their original swapped in.

interface Tracked {
  holder: THREE.Object3D; // world-positioned group whose children are the sand3d version
  sand: THREE.Object3D; // what to hide once the original is in
  id: string;
  og: number;
  fit: THREE.Vector3; // in holder-local units
  state: 'idle' | 'loading' | 'done' | 'none';
  original?: THREE.Group;
}
const tracked: Tracked[] = [];

export function trackForDetail(holder: THREE.Object3D, sand: THREE.Object3D, id: string, og: number | undefined, fit: THREE.Vector3) {
  if (!og) return;
  tracked.push({ holder, sand, id, og, fit, state: 'idle' });
}

const tmp = new THREE.Vector3();
let tick = 0;
export function updateDetail(player: THREE.Vector3, radius: number) {
  if (++tick % 10) return;
  // forget objects from levels that were thrown away
  for (let i = tracked.length - 1; i >= 0; i--) {
    if (!tracked[i].holder.userData.disposed) continue;
    shownTris -= (tracked[i].holder.userData.originalTris as number) || 0;
    // its level is gone: let go of the shared original so the cache can free it
    if (tracked[i].original) releaseOriginal(tracked[i].original!);
    tracked.splice(i, 1);
  }
  if (shownTris < 0) shownTris = 0;
  if (!originalsEnabled) return;
  const near: { t: Tracked; d: number }[] = [];
  for (const t of tracked) {
    if (t.state !== 'idle') continue;
    t.holder.getWorldPosition(tmp);
    const d = tmp.distanceTo(player);
    if (d < radius) near.push({ t, d });
  }
  near.sort((a, b) => a.d - b.d);
  for (const { t, d } of near.slice(0, 6)) {
    t.state = 'loading';
    loadOriginal(t.id, t.og, t.fit, { prio: d, texMax: ORIGINAL_TEX_MAX }).then((g) => {
      if (!g || t.holder.userData.disposed) {
        t.state = g ? 'idle' : 'none';
        if (g) releaseOriginal(g);
        return;
      }
      const tris = lodTris(g); // finest level only (mesh-simplification)
      if (shownTris + tris > MAX_TRIS_TOTAL) {
        releaseOriginal(g);
        t.state = 'none'; // over budget: keep the sand3d version rather than retrying every frame
        return;
      }
      shownTris += tris;
      t.holder.userData.originalTris = tris;
      t.original = g;
      t.holder.add(g);
      t.sand.visible = false;
      t.state = 'done';
    });
  }
}

/** Turn originals off (or on) for everything already in the world. */
export function applyOriginals(v: boolean) {
  setOriginals(v);
  for (const t of tracked) {
    if (t.original) {
      t.original.visible = v;
      t.sand.visible = !v;
    }
  }
}
