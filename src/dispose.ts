import * as THREE from 'three';

/**
 * Freeing GPU resources, and a dev-only leak tracker.
 *
 * Ownership rules used across the game:
 * - geometry is disposed with its tree only when the mesh says it owns it (`userData.owned`, set by
 *   the procedural builders). Shared unit shapes and loader-cache geometry are not owned.
 * - materials and textures are shared through caches (build.ts `mat`, textures.ts, pbr.ts, atlases)
 *   and are pinned for the session; a per-object material/texture (a sign's canvas, a label) is
 *   disposed with its tree when it is tagged `userData.owned` on the material or texture, or
 *   when it was registered with `share()` and its last user lets go (`release`).
 *
 * disposeObject(root, { keep }) does all of that for a subtree; `keep` holds resources that must
 * survive (e.g. a cached template the subtree was cloned from).
 */

type Res = THREE.BufferGeometry | THREE.Material | THREE.Texture;

// ------------------------------------------------------------------ refcounted shared resources
const refs = new WeakMap<Res, number>();
/** pinned resources are never disposed (session-long caches) */
const pinned = new WeakSet<Res>();

export function pin<T extends Res>(r: T): T { pinned.add(r); return r; }
export function isPinned(r: Res) { return pinned.has(r); }
/** one more user of a shared resource */
export function share<T extends Res>(r: T): T { refs.set(r, (refs.get(r) ?? 0) + 1); return r; }
/** one user fewer; disposes it when nobody uses it any more. Returns true if disposed. */
export function release(r: Res): boolean {
  const n = refs.get(r);
  if (n === undefined) return false;
  if (n > 1) { refs.set(r, n - 1); return false; }
  refs.delete(r);
  if (!pinned.has(r)) { r.dispose(); return true; }
  return false;
}
export function refCount(r: Res) { return refs.get(r) ?? 0; }

/** textures a material references (maps and texture uniforms) */
export function texturesOf(m: THREE.Material, out: THREE.Texture[] = []): THREE.Texture[] {
  for (const v of Object.values(m)) if (v && (v as THREE.Texture).isTexture) out.push(v as THREE.Texture);
  const u = (m as THREE.ShaderMaterial).uniforms;
  if (u) for (const k in u) { const v = u[k]?.value; if (v && (v as THREE.Texture).isTexture) out.push(v as THREE.Texture); }
  return out;
}

const mats = (o: THREE.Object3D): THREE.Material[] => {
  const m = (o as THREE.Mesh).material;
  return !m ? [] : Array.isArray(m) ? m : [m];
};

export interface DisposeOpts {
  /** resources never to dispose here */
  keep?: Set<unknown>;
  /** dispose every geometry, not only `userData.owned` ones (for trees built entirely per-owner) */
  allGeometry?: boolean;
  /** dispose every material and its textures that are not pinned or refcounted elsewhere */
  allMaterials?: boolean;
}

/**
 * Free a subtree's GPU resources (geometry, materials, textures, instance buffers, batched meshes,
 * render targets in userData.rt) and mark every node `userData.disposed` (async loaders check it).
 * Shared resources are left alone: pinned, in `keep`, refcounted (released once per use here),
 * or simply not owned.
 */
export function disposeObject(root: THREE.Object3D, opts: DisposeOpts = {}) {
  const keep = opts.keep;
  const seen = new Set<Res>();
  const once = (r: Res, own: boolean) => {
    if (seen.has(r)) return;
    seen.add(r);
    if (keep?.has(r) || pinned.has(r)) return;
    if (refs.has(r)) { release(r); return; }
    if (own) r.dispose();
  };
  root.traverse((c) => {
    c.userData.disposed = true;
    const m = c as THREE.Mesh;
    if ((c as unknown as THREE.BatchedMesh).isBatchedMesh) {
      // BatchedMesh.dispose() frees its own geometry and data textures and must run only once
      seen.add(m.geometry);
      if (!c.userData.gone) { c.userData.gone = true; (c as unknown as THREE.BatchedMesh).dispose(); }
    } else if (m.geometry && (m.isMesh || (c as THREE.Points).isPoints || (c as THREE.Line).isLine))
      once(m.geometry, !!opts.allGeometry || !!m.userData.owned || !!m.geometry.userData.owned);
    if ((c as THREE.InstancedMesh).isInstancedMesh) (c as THREE.InstancedMesh).dispose();
    for (const mt of mats(c)) {
      if (seen.has(mt)) continue;
      seen.add(mt);
      if (keep?.has(mt) || pinned.has(mt)) continue;
      // a material that goes lets go of its textures: refcounted ones are released (one use per
      // material), owned ones disposed. A shared material keeps its textures.
      const gone = refs.has(mt) ? release(mt) : !!opts.allMaterials || !!mt.userData.owned ? (mt.dispose(), true) : false;
      if (!gone) continue;
      for (const t of new Set(texturesOf(mt))) {
        if (keep?.has(t) || pinned.has(t)) continue;
        if (refs.has(t)) release(t);
        else if ((opts.allMaterials || t.userData.owned) && !seen.has(t)) { seen.add(t); t.dispose(); }
      }
    }
    const rt = c.userData.rt as THREE.RenderTarget | undefined;
    if (rt?.dispose) rt.dispose();
  });
}

/** close an ImageBitmap-backed texture's image as well (call after dispose when nothing else reads it) */
export function closeImage(t: THREE.Texture) {
  const img = t.image as ImageBitmap | undefined;
  if (img && typeof (img as ImageBitmap).close === 'function') (img as ImageBitmap).close();
}

// ------------------------------------------------------------------ dev-only leak tracker

interface Entry { ref: WeakRef<Res>; owner: string; kind: 'geometry' | 'material' | 'texture' }
const live = new Map<number, Entry>(); // key: a unique per-resource number
const ids = new WeakMap<Res, number>();
let nextId = 1;
let enabled = false;

/** turn the tracker on (dev builds, ?mem=1, qa tests). Off, every call is a no-op. */
export function enableMemTracker(on = true) { enabled = on; }
export function memTrackerOn() { return enabled; }

function add(r: Res, owner: string, kind: Entry['kind']) {
  if (ids.has(r)) return;
  const id = nextId++;
  ids.set(r, id);
  live.set(id, { ref: new WeakRef(r), owner, kind });
  const onDispose = () => { live.delete(id); ids.delete(r); r.removeEventListener('dispose', onDispose); };
  r.addEventListener('dispose', onDispose);
}

/**
 * Register every geometry, material and texture under `root` as belonging to `owner` (the first
 * owner to see a resource keeps it). A registered resource counts as live until disposed, even
 * when the JS object was collected: an undisposed resource that was drawn stays on the GPU.
 */
export function memTrack(root: THREE.Object3D, owner: string) {
  if (!enabled) return;
  root.traverse((c) => {
    const g = (c as THREE.Mesh).geometry;
    if (g?.isBufferGeometry) add(g, owner, 'geometry');
    for (const m of mats(c)) {
      add(m, owner, 'material');
      for (const t of texturesOf(m)) add(t, owner, 'texture');
    }
  });
}

export interface MemCounts { geometry: number; material: number; texture: number; byOwner: Record<string, { geometry: number; material: number; texture: number; collected: number }> }
/** live (undisposed) tracked resources; `collected` = garbage collected without dispose() (GPU leak if it was drawn) */
export function memCounts(): MemCounts {
  const out: MemCounts = { geometry: 0, material: 0, texture: 0, byOwner: {} };
  for (const e of live.values()) {
    out[e.kind]++;
    const o = (out.byOwner[e.owner] ??= { geometry: 0, material: 0, texture: 0, collected: 0 });
    o[e.kind]++;
    if (!e.ref.deref()) o.collected++;
  }
  return out;
}
/** forget everything tracked so far (tests: start a fresh baseline) */
export function memReset() { live.clear(); }

/** window.__mem(): renderer.info.memory + performance.memory + tracked counts by owner */
export function installMemProbe(renderer: { info: THREE.WebGLRenderer['info'] }) {
  if (typeof window === 'undefined') return;
  (window as unknown as { __mem: () => unknown }).__mem = () => {
    const pm = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
    return {
      gpu: { ...renderer.info.memory, programs: renderer.info.programs?.length ?? 0 },
      heapMB: pm ? Math.round(pm.usedJSHeapSize / 1048576) : null,
      tracked: enabled ? memCounts() : null,
    };
  };
}

/** tracker on: register what each top-level child of `root` (e.g. the scene) holds, owner = its name */
export function memTrackChildren(root: THREE.Object3D) {
  if (!enabled) return;
  for (const c of root.children) memTrack(c, c.name || c.type);
}
