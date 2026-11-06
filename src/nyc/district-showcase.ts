import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Portal } from '../level';
import { Rng, hashN } from '../rng';
import { realScale } from '../realscale';
import { loadRemote, disposeModel, isRebuilt, DATASET_LABEL, type RemoteEntry } from '../remote';
import { toEntry } from '../museumData';
import { trackForDetail } from '../detail';

/**
 * Outdoor showcase objects: the cars on the auto row lots, aircraft on the apron, boats in the
 * marina, benches and playground pieces in the park, crates in the rail yard, produce on market
 * stalls. Each district builder registers *slots* (a place, a footprint and a pool of candidates,
 * public/districts/p/<kind>.json shards from scripts/build_districts.py); the manager streams the sand3d
 * objects in when the player comes near (UV-mapped Blender rebuilds where there are any, the
 * Objaverse original swapped in close up by detail.ts), at real size, and drops them again when
 * the player walks away. A candidate that does not fit its slot at real size is skipped.
 * Every shown object is inspectable (E for details and its program).
 */

export interface SlotSpec {
  /** pool kind(s): public/districts/p/<kind>.json */
  kind: string | string[];
  x: number;
  y?: number;
  z: number;
  /** yaw of the slot; the object's longer side runs along the slot's local x */
  rot?: number;
  /** footprint (slot-local x by z) and height the object must fit at real size */
  w: number;
  d: number;
  h?: number;
  /** smallest acceptable largest dimension (no toy cars in a parking space) */
  min?: number;
  /** start loading within this distance (m) */
  radius?: number;
  /** triangle cap for this one object */
  maxTris?: number;
  /** shown instead when no candidate fits (a lot never has an empty bay) */
  fallback?: () => THREE.Object3D;
  /** random yaw jitter (radians) and whether the object may face either way */
  jitter?: number;
  flip?: boolean;
  seed: number;
}

interface Slot {
  spec: SlotSpec;
  holder: THREE.Group;
  portal: Portal;
  state: 'idle' | 'loading' | 'shown' | 'failed';
  tries: number;
  obj?: THREE.Object3D;
  tris: number;
  entry?: RemoteEntry;
  /** world position (set once the holder is in the scene) */
  wp: THREE.Vector3;
  /** distance to the player at the last update (load priority) */
  dist: number;
  /** give up an in-flight load (chunk dropped, player walked or teleported away) */
  abort?: () => void;
}

const slots: Slot[] = [];
/**
 * Pools load lazily, one shard per kind (public/districts/p/<kind>.json), the first time a slot
 * that uses the kind is near the player: nothing is fetched or parsed at boot.
 */
const pools: Record<string, RemoteEntry[]> = {};
const poolReq = new Map<string, Promise<void>>();
function needPool(k: string) {
  let p = poolReq.get(k);
  if (!p) {
    p = fetch(`${import.meta.env.BASE_URL}districts/p/${k}.json`)
      .then((r) => (r.ok ? r.json() : []))
      .then((raw: unknown[][]) => void (pools[k] = raw.map(toEntry)))
      .catch((e) => {
        console.warn('district pool failed', k, e);
        pools[k] = [];
      });
    poolReq.set(k, p);
  }
  return p;
}
const kindsOf = (s: Slot) => (Array.isArray(s.spec.kind) ? s.spec.kind : [s.spec.kind]);
/** true once all of a slot's pools are in (asks for the missing ones) */
function poolsReady(s: Slot) {
  let ok = true;
  for (const k of kindsOf(s)) if (!pools[k]) { void needPool(k); ok = false; }
  return ok;
}

/** budgets (the lab lowers them for software rendering) */
export const SHOWCASE = { tris: 3_000_000, loads: 4, radius: 110, cap: Infinity };
let shownTris = 0;
let loading = 0;
/** how often each object is on show: prefer ones nobody nearby has */
const used = new Map<string, number>();

/**
 * Register a slot under `parent` (a chunk group, in its local coordinates). The returned portal
 * is pushed to `portals` now with an empty box; it becomes live when the object shows up.
 */
export function addSlot(parent: THREE.Object3D, portals: Portal[], spec: SlotSpec) {
  const holder = new THREE.Group();
  holder.position.set(spec.x, spec.y ?? 0, spec.z);
  holder.rotation.y = spec.rot ?? 0;
  holder.userData.showcase = true;
  parent.add(holder);
  const portal: Portal = { box: new THREE.Box3(), label: '', target: 'inspect' };
  portals.push(portal);
  slots.push({ spec, holder, portal, state: 'idle', tries: 0, tris: 0, wp: new THREE.Vector3(NaN, 0, 0), dist: Infinity });
  return holder;
}

function candidates(s: Slot): RemoteEntry[] {
  const kinds = Array.isArray(s.spec.kind) ? s.spec.kind : [s.spec.kind];
  const list: RemoteEntry[] = [];
  for (const k of kinds) list.push(...(pools[k] ?? []));
  return list;
}

function pickNext(s: Slot): RemoteEntry | null {
  // the first kind is the curated pool: try it first, then any of the kinds
  const kinds = Array.isArray(s.spec.kind) ? s.spec.kind : [s.spec.kind];
  const first = pools[kinds[0]] ?? [];
  const list = s.tries < 3 && first.length ? first : candidates(s);
  if (!list.length) return null;
  const r = new Rng(hashN(s.spec.seed, s.tries, 71));
  // a few draws: prefer a rebuilt (UV-mapped) object nobody nearby is showing
  let best: RemoteEntry | null = null, bestScore = -1;
  for (let i = 0; i < 6; i++) {
    const e = list[Math.floor(r.next() * list.length)];
    const score = (used.get(e.id) ? 0 : 2) + (isRebuilt(e.id) ? 1 : 0) + r.next() * 0.5;
    if (score > bestScore) (best = e), (bestScore = score);
  }
  return best;
}

/**
 * Real size ranges per pool (metres): length = the longer horizontal side, height. Anything
 * outside is rescaled to `target` length if its proportions then fit, else rejected.
 */
export const RANGES: Record<string, { len: [number, number]; h: [number, number]; target: number; keep?: boolean }> = {
  car: { len: [3.6, 6], h: [1.3, 2.1], target: 4.6 },
  carShow: { len: [3.6, 6], h: [1.3, 2.1], target: 4.6 },
  truck: { len: [4, 14], h: [1.9, 4.6], target: 7 },
  bike: { len: [1.4, 2.5], h: [0.7, 1.6], target: 1.9 },
  train: { len: [8, 27], h: [3, 5.2], target: 18 },
  plane: { len: [6, 75], h: [1.8, 20], target: 12 },
  planeStand: { len: [10, 75], h: [3, 20], target: 38 },
  deckPlane: { len: [7, 25], h: [2, 7], target: 16 },
  heli: { len: [7, 22], h: [2.5, 6], target: 13 },
  boat: { len: [2.5, 60], h: [0.5, 30], target: 8 },
  // buildings: never shrunk to fit (a farm made 5 m long is a model, not a shed): out of range = skipped
  structure: { len: [1.8, 14], h: [2, 9], target: 5, keep: true },
  folly: { len: [1.8, 14], h: [2, 9], target: 5, keep: true },
};
/** the uniform factor that brings real-scaled dims into the pool's range (1 = fine), or null to reject */
export function plausible(pool: string | null, x: number, y: number, z: number): number | null {
  const R = pool ? RANGES[pool] : undefined;
  if (!R) return 1;
  const ok = (len: number, h: number) => len >= R.len[0] && len <= R.len[1] && h >= R.h[0] && h <= R.h[1];
  const len = Math.max(x, z);
  if (!(len > 0) || !(y > 0)) return null;
  if (ok(len, y)) return 1;
  if (R.keep) return null;
  const f = R.target / len;
  return ok(len * f, y * f) ? f : null;
}
/** which of the slot's pools an entry came from */
function poolOf(s: Slot, e: RemoteEntry): string | null {
  const kinds = Array.isArray(s.spec.kind) ? s.spec.kind : [s.spec.kind];
  for (const k of kinds) if (pools[k]?.some((x) => x.id === e.id)) return k;
  return null;
}

const tmpBox = new THREE.Box3();
const tmpV = new THREE.Vector3();

/** merge a static model's meshes by material: a few draw calls instead of dozens */
function flatten(root: THREE.Object3D): THREE.Group {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const buckets = new Map<string, { m: THREE.Material; geos: THREE.BufferGeometry[] }>();
  let count = 0;
  root.traverse((o) => void ((o as THREE.Mesh).isMesh && count++));
  if (count <= 6) return root as THREE.Group; // already cheap: keep as is
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    let g = mesh.geometry.clone();
    // meshopt-quantized rebuilds (public/rebuilt/*.glb) store positions/uvs as normalized ints:
    // transforming those in place clamps them to [-1, 1] (a 2 m cube of a plane) and mixed array
    // types make mergeGeometries fail (that material's parts dropped). Work in plain floats.
    for (const k of ['position', 'normal', 'uv']) {
      const a = g.getAttribute(k) as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
      if (!a || (!(a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute && a.array instanceof Float32Array && !a.normalized)) continue;
      const f = new Float32Array(a.count * a.itemSize);
      const get = [a.getX, a.getY, a.getZ, a.getW];
      for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) f[i * a.itemSize + c] = get[c].call(a, i);
      g.setAttribute(k, new THREE.BufferAttribute(f, a.itemSize));
    }
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld));
    if (g.index) g = g.toNonIndexed();
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    for (const k of Object.keys(g.morphAttributes)) delete g.morphAttributes[k];
    const sig = `${mesh.material.uuid}|${g.getAttribute('uv') ? 1 : 0}`;
    let b = buckets.get(sig);
    if (!b) buckets.set(sig, (b = { m: mesh.material, geos: [] }));
    b.geos.push(g);
  });
  const out = new THREE.Group();
  for (const b of buckets.values()) {
    const merged = mergeGeometries(b.geos, false);
    b.geos.forEach((g) => g.dispose());
    if (!merged) continue;
    const m = new THREE.Mesh(merged, b.m);
    m.castShadow = m.receiveShadow = true;
    m.userData.owned = true;
    out.add(m);
  }
  disposeModel(root);
  return out;
}

async function load(s: Slot) {
  const spec = s.spec;
  // an abort settles the load at once: the slot's place in the queue goes to slots near the player
  const aborted = new Promise<null>((res) => (s.abort = () => res(null)));
  while (s.tries < 6) {
    const e = pickNext(s);
    s.tries++;
    if (!e) break;
    let m;
    try {
      const req = loadRemote(e, { prio: s.dist, shadows: true });
      m = await Promise.race([req, aborted]);
      if (!m) {
        // the late model is dropped when it arrives
        req.then((late) => disposeModel(late.object)).catch(() => {});
        s.tries = 0;
        if (!s.holder.userData.disposed) s.state = 'idle';
        return;
      }
    } catch {
      continue;
    }
    if (s.holder.userData.disposed) {
      disposeModel(m.object);
      return;
    }
    // measure the model as built, then bring it to real size
    const obj = m.object;
    tmpBox.setFromObject(obj);
    const size = tmpBox.getSize(new THREE.Vector3());
    let k = realScale(e.title, e.entry, e.family, Math.max(size.x, size.y, size.z), e.ds);
    // vehicles, aircraft and boats must also land in their real ranges (a model titled "BMW 4"
    // has no size word, and the family range alone would leave it toy-sized)
    const fix = plausible(poolOf(s, e), size.x * k, size.y * k, size.z * k);
    if (fix === null) {
      disposeModel(m.object);
      continue;
    }
    k *= fix;
    const dim = size.clone().multiplyScalar(k);
    const maxTris = spec.maxTris ?? 200_000;
    // the longer horizontal side along the slot's x
    const turn = dim.z > dim.x;
    const fx = turn ? dim.z : dim.x, fz = turn ? dim.x : dim.z;
    const fits = fx <= spec.w * 1.05 && fz <= spec.d * 1.05 && dim.y <= (spec.h ?? 1e9) && Math.max(dim.x, dim.y, dim.z) >= (spec.min ?? 0);
    if (!fits || m.tris > maxTris || shownTris + m.tris > SHOWCASE.tris) {
      disposeModel(obj);
      continue;
    }
    // centre on x/z, base on the ground
    const c = tmpBox.getCenter(tmpV);
    const inner = new THREE.Group();
    const flat = flatten(obj);
    flat.position.set(-c.x, -tmpBox.min.y, -c.z);
    inner.add(flat);
    inner.scale.setScalar(k);
    const yaw = (turn ? Math.PI / 2 : 0) + (spec.flip && hashN(spec.seed, 3) % 2 ? Math.PI : 0) + (spec.jitter ? ((hashN(spec.seed, 9) % 1000) / 1000 - 0.5) * 2 * spec.jitter : 0);
    const turnG = new THREE.Group();
    turnG.rotation.y = yaw;
    turnG.add(inner);
    s.holder.add(turnG);
    s.obj = turnG;
    s.tris = m.tris;
    s.entry = e;
    shownTris += m.tris;
    used.set(e.id, (used.get(e.id) ?? 0) + 1);
    // the textured Objaverse original when the player comes close
    trackForDetail(turnG, inner, e.id, e.og, dim.clone());
    s.holder.updateWorldMatrix(true, true);
    s.portal.box.setFromObject(turnG).expandByScalar(0.1);
    s.portal.label = e.title;
    s.portal.sub = `${DATASET_LABEL[e.ds] ?? e.ds}${e.author ? ` · by ${e.author}` : ''} — E for details & its program`;
    s.portal.inspect = e;
    // which pool it came from (e2e checks boats by it, not by title)
    (s.portal as Portal & { pool?: string }).pool = poolOf(s, e) ?? undefined;
    s.state = 'shown';
    return;
  }
  s.state = 'failed';
  if (s.spec.fallback && !s.holder.userData.disposed && !s.holder.userData.fellBack) {
    s.holder.userData.fellBack = true;
    s.holder.add(s.spec.fallback());
  }
}

function unload(s: Slot) {
  if (s.obj) {
    s.holder.remove(s.obj);
    s.obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.userData.owned) m.geometry.dispose();
    });
    s.obj.userData.disposed = true;
    s.obj.traverse((o) => (o.userData.disposed = true));
  }
  if (s.entry) used.set(s.entry.id, Math.max(0, (used.get(s.entry.id) ?? 1) - 1));
  shownTris -= s.tris;
  s.obj = undefined;
  s.entry = undefined;
  s.tris = 0;
  s.tries = 0;
  s.portal.box.makeEmpty();
  s.state = 'idle';
}

/** a holder counts as placed once its ancestors reach a scene (or a root marked as the world) */
function placed(o: THREE.Object3D) {
  let a: THREE.Object3D | null = o;
  while (a.parent) a = a.parent;
  return (a as THREE.Scene).isScene === true;
}

let frame = 0;
/** call every frame with the player position */
export function updateShowcases(p: THREE.Vector3) {
  if (++frame % 12) return;
  // forget slots of chunks that were thrown away
  for (let i = slots.length - 1; i >= 0; i--) {
    const s = slots[i];
    if (!s.holder.userData.disposed) continue;
    if (s.state === 'shown') unload(s);
    if (s.state === 'loading') s.abort?.();
    slots.splice(i, 1);
  }
  const want: { s: Slot; d: number }[] = [];
  for (const s of slots) {
    if (Number.isNaN(s.wp.x)) {
      // only once the chunk is placed in the world: blocks are built over several frames and
      // positioned at the end (a position taken earlier is block-local and never near the player)
      if (!placed(s.holder)) continue;
      s.holder.updateWorldMatrix(true, false);
      s.holder.getWorldPosition(s.wp);
    }
    const d = Math.hypot(s.wp.x - p.x, s.wp.z - p.z);
    s.dist = d;
    const R = Math.min(SHOWCASE.cap, s.spec.radius ?? SHOWCASE.radius);
    if (s.state === 'shown' && d > R + 40) unload(s);
    else if (s.state === 'loading' && d > R + 40) s.abort?.();
    else if (s.state === 'idle' && d < R && poolsReady(s)) want.push({ s, d });
  }
  want.sort((a, b) => a.d - b.d);
  for (const { s } of want) {
    if (loading >= SHOWCASE.loads) break;
    s.state = 'loading';
    loading++;
    load(s).finally(() => loading--);
  }
}

/** the registered slots under a root (for qa tests) */
export function slotsUnder(root: THREE.Object3D) {
  return slots.filter((s) => {
    let o: THREE.Object3D | null = s.holder;
    while (o && o !== root) o = o.parent;
    return o === root;
  }).map((s) => s.spec);
}

/** per-slot state under a root (qa) */
export function slotDebug(root: THREE.Object3D) {
  return slots.filter((s) => {
    let o: THREE.Object3D | null = s.holder;
    while (o && o !== root) o = o.parent;
    return o === root;
  }).map((s) => ({ state: s.state, x: s.wp.x, z: s.wp.z, dist: s.dist }));
}
/** resolves once the given pools are loaded (qa) */
export function showcaseReady(kinds: string[] = []) {
  return Promise.all(kinds.map(needPool));
}

/** stats for the labs */
export function showcaseStats() {
  return { slots: slots.length, shown: slots.filter((s) => s.state === 'shown').length, failed: slots.filter((s) => s.state === 'failed').length, loading, tris: shownTris };
}
/** everything currently on show (for the lab's report) */
export function shownEntries() {
  return slots.filter((s) => s.entry).map((s) => ({ kind: s.spec.kind, title: s.entry!.title, family: s.entry!.family }));
}

// e2e: the harness imports modules separately, so expose the live stats on the page
if (typeof window !== 'undefined') (window as unknown as { __showcase: unknown }).__showcase = { stats: showcaseStats, shown: shownEntries };
