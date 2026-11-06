import * as THREE from 'three';
import { zfixStats } from './zfight';
import { museumLook } from './looks';

/**
 * The exhibit flicker fix (zfight.ts) on a Web Worker (zworker.ts): the main thread only copies the
 * exhibit's merged meshes into typed arrays and swaps in the geometries that come back. Where there
 * is no Worker (Node qa) or it fails, `fallback` runs instead (the idle-time fix on the main thread).
 */
type Arr = Float32Array | Uint16Array | Uint32Array | Int16Array | Int8Array | Uint8Array;
export interface ZGeo {
  attrs: Record<string, { array: Arr; itemSize: number; normalized: boolean }>;
  index: Uint16Array | Uint32Array | null;
  groups: { start: number; count: number; materialIndex?: number }[];
}
export interface ZJob {
  id: number;
  lift: number;
  meshes: { matrix: number[]; offset: boolean; additive: boolean; geo: ZGeo }[];
}
export interface ZReply {
  id: number;
  moved: number;
  ms: number;
  changed: { i: number; geo: ZGeo }[];
  /** per mesh: an open surface (see open.ts) */
  open: boolean[];
}

/** exhibits bigger than this are not fixed */
const MAX_TRIS = 50_000;
let worker: Worker | null | undefined;
let seq = 0;
const waiting = new Map<number, { meshes: THREE.Mesh[]; done: (ok: boolean) => void }>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  worker = null;
  if (typeof Worker === 'undefined' || typeof window === 'undefined') return null;
  try {
    const w = new Worker(new URL('./zworker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<ZReply>) => apply(e.data);
    w.onerror = () => {
      // broken worker: everything waiting (and everything after) takes the fallback
      worker = null;
      for (const [, j] of waiting) j.done(false);
      waiting.clear();
    };
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

function apply(r: ZReply) {
  const j = waiting.get(r.id);
  if (!j) return;
  waiting.delete(r.id);
  const t0 = performance.now();
  for (const { i, geo } of r.changed) {
    const m = j.meshes[i];
    if (!m) continue;
    const g = new THREE.BufferGeometry();
    for (const [n, a] of Object.entries(geo.attrs)) g.setAttribute(n, new THREE.BufferAttribute(a.array, a.itemSize, a.normalized));
    if (geo.index) g.setIndex(new THREE.BufferAttribute(geo.index, 1));
    for (const gr of geo.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
    // lifts are millimetres: the old bounds still hold
    g.boundingSphere = m.geometry.boundingSphere?.clone() ?? null;
    g.boundingBox = m.geometry.boundingBox?.clone() ?? null;
    if (!g.boundingSphere) g.computeBoundingSphere();
    g.userData.zfixOwned = true;
    g.userData.open = m.geometry.userData.open;
    m.geometry = g;
  }
  // closed surfaces authored double-sided: the front-sided look (prewarmed; no back faces shaded)
  r.open.forEach((open, i) => {
    const m = j.meshes[i];
    if (!m) return;
    m.geometry.userData.open = open;
    const mat = m.material as THREE.Material;
    if (!open && !Array.isArray(m.material) && mat.side === THREE.DoubleSide) m.material = museumLook(mat, false);
  });
  zfixStats.push({ kind: 'worker', ms: r.ms, moved: r.moved });
  zfixStats.push({ kind: 'apply', ms: performance.now() - t0, moved: r.moved });
  zfixStats.push({ kind: 'pack', ms: pending.get(r.id) ?? 0, moved: r.moved });
  pending.delete(r.id);
  if (zfixStats.length > 400) zfixStats.splice(0, zfixStats.length - 400);
  j.done(true);
}
/** main-thread ms spent packing each job (added to its apply time in the 'exhibit' stat) */
const pending = new Map<number, number>();

/**
 * Fix `root`'s exhibit meshes off the main thread. `then` runs once they are fixed (geometries
 * swapped); `fallback` instead, if there is no worker.
 */
export function fixOffThread(root: THREE.Object3D, lift: number, then: () => void, fallback: () => void) {
  const w = getWorker();
  if (!w) return fallback();
  const t0 = performance.now();
  // copying a big scan costs the main thread more than a frame can spare (13 ms at ~200k triangles):
  // those are left as they are
  let tris = 0;
  root.traverse((o) => {
    const g = (o as THREE.Mesh).geometry;
    if (g) tris += (g.index ? g.index.count : (g.getAttribute('position')?.count ?? 0)) / 3;
  });
  if (tris > MAX_TRIS) {
    zfixStats.push({ kind: 'skip', ms: 0, moved: 0 });
    return then();
  }
  root.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  const job: ZJob = { id: ++seq, lift, meshes: [] };
  const transfer: Transferable[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as unknown as THREE.InstancedMesh).isInstancedMesh) return;
    for (let p: THREE.Object3D | null = m; p && p !== root.parent; p = p.parent) if (!p.visible) return;
    const g = m.geometry;
    if (!g?.getAttribute('position')) return;
    const mats = (Array.isArray(m.material) ? m.material : [m.material]) as THREE.Material[];
    if (mats.every((x) => !x || x.colorWrite === false || x.visible === false)) return;
    const geo: ZGeo = { attrs: {}, index: null, groups: g.groups.map((x) => ({ ...x })) };
    for (const [n, a] of Object.entries(g.attributes)) {
      const b = a as THREE.BufferAttribute;
      // interleaved / odd attributes can't be copied simply: leave this mesh to the fallback
      if (!(b as unknown as { isBufferAttribute?: boolean }).isBufferAttribute) return;
      const arr = (b.array as Arr).slice();
      geo.attrs[n] = { array: arr, itemSize: b.itemSize, normalized: b.normalized };
      transfer.push(arr.buffer);
    }
    if (g.index) {
      geo.index = (g.index.array as Uint16Array | Uint32Array).slice();
      transfer.push(geo.index.buffer);
    }
    meshes.push(m);
    job.meshes.push({
      matrix: m.matrixWorld.toArray(),
      offset: mats.some((x) => x?.polygonOffset),
      additive: mats.some((x) => x?.blending === THREE.AdditiveBlending),
      geo,
    });
  });
  if (!meshes.length) return then();
  waiting.set(job.id, { meshes, done: (ok) => (ok ? then() : fallback()) });
  pending.set(job.id, performance.now() - t0);
  w.postMessage(job, transfer);
}
