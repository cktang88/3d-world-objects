import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
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

export function initDetail(renderer: THREE.WebGLRenderer) {
  const base = import.meta.env.BASE_URL;
  const draco = new DRACOLoader().setDecoderPath(`${base}libs/draco/`);
  const ktx2 = new KTX2Loader().setTranscoderPath(`${base}libs/basis/`).detectSupport(renderer);
  loader = new GLTFLoader().setDRACOLoader(draco).setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
  maxAniso = renderer.capabilities.getMaxAnisotropy();
}
let maxAniso = 8;

export function originalUrl(id: string, og: number) {
  const uid = id.replace(/^objaverse-/, '');
  return `https://huggingface.co/datasets/allenai/objaverse/resolve/main/glbs/000-${String(og).padStart(3, '0')}/${uid}.glb`;
}

const MAX_BYTES = 40e6;
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
    const gltf = await loader!.parseAsync(buf, '');
    const scene = gltf.scene;
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(scene);
    if (box.isEmpty()) return null;
    await shrinkTextures(scene, texMax);
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
export async function loadOriginal(id: string, og: number | undefined, fit: THREE.Vector3, opts: { prio?: number; texMax?: number } = {}): Promise<THREE.Group | null> {
  if (!og || !originalsEnabled || !loader || failed.has(id)) return null;
  let p = cache.get(id);
  if (!p) {
    p = fetchOriginal(id, og, opts.prio ?? 0, opts.texMax ?? 2048);
    cache.set(id, p);
    trim();
  }
  const c = await p;
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
    loadOriginal(t.id, t.og, t.fit, { prio: d, texMax: 2048 }).then((g) => {
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
