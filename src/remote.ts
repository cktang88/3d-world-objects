import * as THREE from 'three';
import type { ParsedObject, JointDef } from './usda/parse';
import { kindOf, enhance, glassFrom, enhanceTree } from './materials';
import { gltf } from './detail';
import { checkSize } from './rebuiltCheck';
import { ABORTED, CopyTracker, disposeObject } from './dispose';

/** One object anywhere in the sand3d release, streamed from Hugging Face on demand. */
export interface RemoteEntry {
  ds: string;
  split: string;
  row: number;
  id: string;
  family: string;
  entry: string;
  title: string;
  author: string;
  url: string;
  license: string;
  path: string;
  bytes: number;
  f: number;
  joints: number;
  attribution?: string;
  /** Objaverse glbs/000-NNN folder of the original textured model, 0 if none */
  og?: number;
}

export const DATASET_LABEL: Record<string, string> = {
  objaverse: 'Objaverse',
  cad: 'CAD parts (Zero-To-CAD)',
  articraft: 'Articraft mechanisms',
  simready: 'NVIDIA SimReady',
  automate: 'AutoMate assemblies',
};

export function usdaUrl(e: RemoteEntry) {
  return `https://huggingface.co/datasets/Sandflow/sand3d-${e.ds}/resolve/main/${e.path}`;
}

// ---- worker pool ------------------------------------------------------------

const POOL = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
const workers: Worker[] = [];
const busy: boolean[] = [];
let reqId = 0;
const pending = new Map<number, { resolve: (p: ParsedObject) => void; reject: (e: Error) => void }>();
const queue: { url: string; resolve: (p: ParsedObject) => void; reject: (e: Error) => void; prio: number }[] = [];
/** [memory] queued (not started) parses and how many callers still want each (loadRemote with a signal) */
const queuedJob = new Map<string, { job: (typeof queue)[number]; wanted: number; anyone: boolean }>();

function makeWorker(i: number) {
  const w = new Worker(new URL('./usda/worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (ev: MessageEvent<{ id: number; parsed?: ParsedObject; error?: string }>) => {
    const p = pending.get(ev.data.id);
    pending.delete(ev.data.id);
    busy[i] = false;
    if (p) {
      if (ev.data.parsed) p.resolve(ev.data.parsed);
      else p.reject(new Error(ev.data.error));
    }
    pump();
  };
  workers[i] = w;
  busy[i] = false;
}

function pump() {
  if (!workers.length) for (let i = 0; i < POOL; i++) makeWorker(i);
  for (let i = 0; i < workers.length && queue.length; i++) {
    if (busy[i]) continue;
    queue.sort((a, b) => a.prio - b.prio);
    const job = queue.shift()!;
    const id = ++reqId;
    pending.set(id, job);
    busy[i] = true;
    workers[i].postMessage({ id, url: job.url });
  }
}

const parsedCache = new Map<string, Promise<ParsedObject>>();
const CACHE_MAX = 220;

function loadParsed(e: RemoteEntry, prio: number, signal?: AbortSignal): Promise<ParsedObject> {
  let p = parsedCache.get(e.id);
  if (p) {
    parsedCache.delete(e.id);
    parsedCache.set(e.id, p); // LRU bump
  } else {
    p = new Promise<ParsedObject>((resolve, reject) => {
      const job = { url: usdaUrl(e), resolve, reject, prio };
      queue.push(job);
      queuedJob.set(e.id, { job, wanted: 0, anyone: false });
      pump();
    });
    parsedCache.set(e.id, p);
    p.catch(() => parsedCache.delete(e.id)).finally(() => queuedJob.delete(e.id));
    while (parsedCache.size > CACHE_MAX) parsedCache.delete(parsedCache.keys().next().value!);
  }
  const q = queuedJob.get(e.id);
  if (!q) return p;
  if (!signal) {
    q.anyone = true; // a caller that cannot cancel: the parse stays queued
    return p;
  }
  return wanted(p, signal, e.id, q);
}

const aborted = () => ABORTED; // shared: see dispose.ts
/**
 * [memory] p for one caller that may give up (signal): an aborted caller is rejected at once (its
 * continuation, which may hold a whole evicted level, is released), and a queued parse nobody wants
 * any more is taken off the queue, so no reactions pile up on a parse that will not run soon.
 */
function wanted<T>(p: Promise<T>, signal: AbortSignal, id: string, q: { job: (typeof queue)[number]; wanted: number; anyone: boolean }): Promise<T> {
  if (signal.aborted) return Promise.reject(aborted());
  q.wanted++;
  return new Promise<T>((res, rej) => {
    let done = false;
    const onAbort = () => {
      if (done) return;
      done = true;
      rej(aborted());
      if (--q.wanted <= 0 && !q.anyone && queuedJob.get(id) === q) {
        const i = queue.indexOf(q.job);
        if (i >= 0) {
          queue.splice(i, 1);
          q.job.reject(aborted());
        }
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => { if (!done) { done = true; signal.removeEventListener('abort', onAbort); res(v); } },
      (err) => { if (!done) { done = true; signal.removeEventListener('abort', onAbort); rej(err); } },
    );
  });
}

/** while n > 0, clearQueue() does nothing (seamless.ts disposing a cached level in the background) */
export const queueHold = { n: 0 };
/** Drop queued (not yet started) loads, e.g. when leaving a room. */
export function clearQueue() {
  if (queueHold.n > 0) return;
  for (const j of queue.splice(0)) j.reject(new Error('cancelled'));
}

// ---- three.js objects -------------------------------------------------------

const matCache = new Map<string, THREE.Material>();
function material(m: ParsedObject['materials'][number]) {
  // geometry with no material at all (most CAD parts) is shown as machined aluminium
  const unbound = m.name === 'default';
  if (unbound) {
    m = { ...m, color: [0.78, 0.8, 0.83], metal: 0.9, rough: 0.32 };
  }
  const kind = unbound ? 'aluminium' : kindOf(m.name);
  const key = `${kind}|${m.color.map((c) => c.toFixed(3))}|${m.rough}|${m.metal}|${m.opacity}|${m.emissive}`;
  const hit = matCache.get(key);
  if (hit) return hit;
  {
    const mt = new THREE.MeshStandardMaterial({
      color: new THREE.Color(...m.color.map((c) => Math.min(1, Math.max(0, c))) as [number, number, number]),
      roughness: Math.min(1, Math.max(0.04, m.rough)),
      metalness: Math.min(1, Math.max(0, m.metal)),
      transparent: m.opacity < 0.99,
      opacity: Math.max(0.12, m.opacity),
      depthWrite: m.opacity >= 0.99,
      side: THREE.DoubleSide,
    });
    if (m.emissive.some((c) => c > 0)) {
      mt.emissive = new THREE.Color(...(m.emissive as [number, number, number]));
    }
    mt.name = m.name;
    const out: THREE.Material = kind === 'glass' ? glassFrom(mt) : kind ? enhance(mt, kind) : mt;
    matCache.set(key, out);
    return out;
  }
}

export interface Animator {
  joints: { joint: JointDef; node: THREE.Object3D; rest: THREE.Matrix4; pivot: THREE.Vector3; axis: THREE.Vector3; phase: number }[];
}

export interface RemoteModel {
  /** Y-up group with its base centred at the origin, real metres */
  object: THREE.Group;
  size: THREE.Vector3;
  animator: Animator | null;
  tris: number;
}

/** Build a three.js object; joints become a node hierarchy we can animate. */
function buildModel(p: ParsedObject, shadows: boolean): RemoteModel {
  const zup = new THREE.Group();
  const nodes = new Map<string, THREE.Object3D>();
  for (const b of p.bodies) {
    const node = new THREE.Group();
    node.matrixAutoUpdate = false;
    node.matrix.fromArray(b.matrix);
    for (const part of b.parts) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(part.pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(part.nrm, 3));
      g.setIndex(new THREE.BufferAttribute(part.idx, 1));
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, material(p.materials[part.mat]));
      mesh.castShadow = shadows;
      mesh.receiveShadow = shadows;
      node.add(mesh);
    }
    zup.add(node);
    nodes.set(b.path, node);
  }
  // re-parent along joints (child keeps its world pose)
  let animator: Animator | null = null;
  if (p.joints.length) {
    animator = { joints: [] };
    zup.updateMatrixWorld(true);
    const world = (n: THREE.Object3D) => n.matrix.clone();
    const worldOf = new Map<THREE.Object3D, THREE.Matrix4>();
    nodes.forEach((n) => worldOf.set(n, world(n)));
    for (const j of p.joints) {
      const parent = nodes.get(j.body0);
      const child = nodes.get(j.body1);
      if (!parent || !child || parent === child) continue;
      if (child.parent !== zup) continue; // already attached elsewhere
      // avoid cycles
      let a: THREE.Object3D | null = parent;
      let cyc = false;
      while (a) { if (a === child) cyc = true; a = a.parent; }
      if (cyc) continue;
      const rel = worldOf.get(parent)!.clone().invert().multiply(worldOf.get(child)!);
      zup.remove(child);
      parent.add(child);
      child.matrix.copy(rel);
      const q = new THREE.Quaternion(j.rot1[1], j.rot1[2], j.rot1[3], j.rot1[0]);
      const axis = new THREE.Vector3(j.axis === 'X' ? 1 : 0, j.axis === 'Y' ? 1 : 0, j.axis === 'Z' ? 1 : 0).applyQuaternion(q).normalize();
      animator.joints.push({ joint: j, node: child, rest: rel.clone(), pivot: new THREE.Vector3(...j.pos1), axis, phase: Math.random() * Math.PI * 2 });
    }
    if (!animator.joints.length) animator = null;
  }
  // Z-up metres -> Y-up, base at origin, centred on X/Z
  const root = new THREE.Group();
  zup.rotation.x = -Math.PI / 2;
  const cx = (p.min[0] + p.max[0]) / 2, cy = (p.min[1] + p.max[1]) / 2;
  // after rotation: x->x, y->-z, z->y
  zup.position.set(-cx, -p.min[2], cy);
  root.add(zup);
  const size = new THREE.Vector3(p.max[0] - p.min[0], p.max[2] - p.min[2], p.max[1] - p.min[1]);
  return { object: root, size, animator, tris: p.tris };
}

/** ids rebuilt from their sand3d programs in Blender, with UV maps (public/rebuilt/) */
let rebuilt: Set<string> = new Set();
/** the source USDA's size of each rebuilt id (public/rebuilt/dims.json, scripts/audit_rebuilt.mjs) */
let rebuiltDims: Record<string, [number, number, number]> = {};
export async function loadRebuiltIndex() {
  try {
    rebuilt = new Set(await (await fetch(`${import.meta.env.BASE_URL}rebuilt/index.json`)).json());
  } catch {
    rebuilt = new Set();
  }
  try {
    rebuiltDims = await (await fetch(`${import.meta.env.BASE_URL}rebuilt/dims.json`)).json();
  } catch {
    rebuiltDims = {};
  }
}
export function isRebuilt(id: string) {
  return rebuilt.has(id);
}
const glbCache = new Map<string, Promise<{ scene: THREE.Group; size: THREE.Vector3; tris: number }>>();
/** copies of cached rebuilt models (their geometry is shared, so the cache frees it): see trimGlb */
const glbCopies = new CopyTracker();
/** rebuilt models kept cached with no copy in use; beyond this the least recently used are freed */
const GLB_UNUSED_MAX = 24;
function trimGlb() {
  for (const k of glbCopies.excess(glbCache.keys(), GLB_UNUSED_MAX)) {
    const p = glbCache.get(k)!;
    glbCache.delete(k);
    glbCopies.forget(k);
    p.then((r) => disposeObject(r.scene, { allGeometry: true, allMaterials: true }), () => undefined);
  }
}
// [museum] rebuilt GLB downloads: at most GLB_CONC at once, the most urgent (lowest prio) first, so a
// prebuilt room's dozens of models do not crowd out the room you are in (reprioritize on entering)
const GLB_CONC = 4;
let glbActive = 0;
const glbWait: { id: string; prio: number; go: () => void }[] = [];
function pumpGlb() {
  while (glbActive < GLB_CONC && glbWait.length) {
    glbWait.sort((a, b) => a.prio - b.prio);
    glbWait.shift()!.go();
  }
}
function glbSlot(id: string, prio: number): Promise<() => void> {
  return new Promise((res) => {
    glbWait.push({ id, prio, go: () => {
      glbActive++;
      res(() => {
        glbActive--;
        pumpGlb();
      });
    } });
    pumpGlb();
  });
}
/** [museum] a queued (not started) load becomes more or less urgent */
export function reprioritize(id: string, prio: number) {
  const q = queuedJob.get(id);
  if (q) q.job.prio = prio;
  for (const w of glbWait) if (w.id === id) w.prio = prio;
}
/** [museum] the priority of a queued load (qa), undefined if not queued */
export function queuedPrio(id: string): number | undefined {
  return queuedJob.get(id)?.job.prio ?? glbWait.find((w) => w.id === id)?.prio;
}

function loadRebuilt(e: RemoteEntry, prio = 0) {
  let p = glbCache.get(e.id);
  if (p) {
    glbCache.delete(e.id);
    glbCache.set(e.id, p); // LRU bump
  } else {
    const url = `${import.meta.env.BASE_URL}rebuilt/${e.id}.glb`;
    p = glbSlot(e.id, prio).then((done) => gltf()!.loadAsync(url).finally(done)).then((g) => {
      enhanceTree(g.scene);
      let tris = 0;
      g.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.userData.shared = true;
        m.castShadow = m.receiveShadow = true;
        tris += (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute('position').count) / 3;
      });
      const size = new THREE.Box3().setFromObject(g.scene).getSize(new THREE.Vector3());
      return { scene: g.scene, size, tris: Math.round(tris) };
    });
    glbCache.set(e.id, p);
    p.catch(() => glbCache.delete(e.id));
    trimGlb();
  }
  return p;
}

/** opts.signal: abort when the caller (a level) is gone: its continuation is dropped and a queued parse only it wanted is cancelled */
export function loadRemote(e: RemoteEntry, opts: { prio?: number; shadows?: boolean; signal?: AbortSignal } = {}): Promise<RemoteModel> {
  if (opts.signal?.aborted) return Promise.reject(aborted());
  // prefer the UV-mapped rebuild (static objects only: joints come from the USD)
  if (rebuilt.has(e.id) && !e.joints && gltf()) {
    const p = loadRebuilt(e, opts.prio ?? 0);
    return p.then((r): RemoteModel | Promise<RemoteModel> => {
      if (glbCache.get(e.id) !== p) return loadRemote(e, opts); // freed while we waited: load it afresh
      // safety net: a rebuild whose size or axes disagree with its source USDA is not used
      const want = rebuiltDims[e.id];
      if (want && !checkSize(r.size.toArray(), want, 1.5).ok) {
        console.warn('rebuilt GLB disagrees with its USDA, using the USDA:', e.id, r.size.toArray(), want);
        rebuilt.delete(e.id);
        return loadParsed(e, opts.prio ?? 0, opts.signal).then((p) => buildModel(p, opts.shadows ?? true));
      }
      const object = r.scene.clone(true);
      glbCopies.add(e.id, object);
      return { object, size: r.size.clone(), animator: null, tris: r.tris };
    });
  }
  return loadParsed(e, opts.prio ?? 0, opts.signal).then((p) => buildModel(p, opts.shadows ?? true));
}

const tmpM = new THREE.Matrix4();
const tmpT = new THREE.Matrix4();
const tmpR = new THREE.Matrix4();
/** Swing revolute joints and slide prismatic ones back and forth. */
export function animate(a: Animator, time: number) {
  for (const j of a.joints) {
    const { joint } = j;
    const s = 0.5 + 0.5 * Math.sin(time * 0.9 + j.phase);
    if (joint.kind === 'revolute') {
      const lo = Number.isFinite(joint.lower) ? joint.lower : null;
      const hi = Number.isFinite(joint.upper) ? joint.upper : null;
      const deg = lo === null || hi === null ? (time * 40 + j.phase * 57) % 360 : lo + (hi - lo) * s;
      tmpR.makeRotationAxis(j.axis, THREE.MathUtils.degToRad(deg));
      tmpT.makeTranslation(j.pivot.x, j.pivot.y, j.pivot.z);
      tmpM.copy(j.rest).multiply(tmpT).multiply(tmpR).multiply(tmpT.makeTranslation(-j.pivot.x, -j.pivot.y, -j.pivot.z));
    } else {
      const lo = Number.isFinite(joint.lower) ? joint.lower : 0;
      const hi = Number.isFinite(joint.upper) ? joint.upper : 0.1;
      const d = lo + (hi - lo) * s;
      tmpM.copy(j.rest).multiply(tmpT.makeTranslation(j.axis.x * d, j.axis.y * d, j.axis.z * d));
    }
    j.node.matrix.copy(tmpM);
  }
}

export function disposeModel(o: THREE.Object3D) {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.isMesh && !m.userData.shared) m.geometry.dispose();
  });
}
