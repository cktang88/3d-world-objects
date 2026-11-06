import * as THREE from 'three';
import { loadRemote, disposeModel, type RemoteEntry, type RemoteModel } from '../remote';
import { realScale } from '../realscale';

/**
 * Real sizes. A room is laid out around what it holds, so we need every object's size before
 * we build it. Sizes are measured once (by streaming the object) and remembered, in memory and
 * in localStorage, so a room you come back to is built instantly and identically.
 */
const KEY = 'sand3d-museum-sizes-v1';
const MAX = 30000;
const mem = new Map<string, [number, number, number]>();
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function boot() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, [number, number, number]>)) mem.set(k, v);
  } catch {
    /* private mode etc. */
  }
}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    while (mem.size > MAX) mem.delete(mem.keys().next().value!);
    try {
      localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(mem)));
    } catch {
      /* quota */
    }
  }, 1500);
}

export function knownRaw(id: string): THREE.Vector3 | null {
  boot();
  const v = mem.get(id);
  return v ? new THREE.Vector3(v[0], v[1], v[2]) : null;
}

export function remember(id: string, raw: THREE.Vector3) {
  boot();
  mem.set(id, [+raw.x.toFixed(5), +raw.y.toFixed(5), +raw.z.toFixed(5)]);
  save();
}

/** An object with its real-world size: `k` is the realScale correction (1 for objects modelled at true size). */
export interface Measured {
  entry: RemoteEntry;
  raw: THREE.Vector3;
  k: number;
  real: THREE.Vector3;
  /** a library scan (not a sand3d program): loads with load() */
  library?: boolean;
  load?: () => Promise<RemoteModel>;
  /** the model, if we had to stream it to measure it */
  model?: RemoteModel;
}

export function realOf(e: RemoteEntry, raw: THREE.Vector3): { k: number; real: THREE.Vector3 } {
  const k = realScale(e.title, e.entry, e.family, Math.max(raw.x, raw.y, raw.z), e.ds);
  return { k, real: raw.clone().multiplyScalar(k) };
}

export function measuredFromCache(e: RemoteEntry): Measured | null {
  const raw = knownRaw(e.id);
  if (!raw) return null;
  return { entry: e, raw, ...realOf(e, raw) };
}

/** Measure one object (streams it unless its size is known). */
export function measure(e: RemoteEntry, prio: number): Promise<Measured> {
  const hit = measuredFromCache(e);
  if (hit) return Promise.resolve(hit);
  return loadRemote(e, { prio, shadows: false }).then((m) => {
    remember(e.id, m.size);
    return { entry: e, raw: m.size.clone(), ...realOf(e, m.size), model: m };
  });
}

/** Learn sizes in the background (for the rooms behind the doorways), keeping nothing. */
export function prefetchSizes(entries: RemoteEntry[], prio: number) {
  for (const e of entries) {
    if (knownRaw(e.id)) continue;
    loadRemote(e, { prio, shadows: false })
      .then((m) => {
        remember(e.id, m.size);
        disposeModel(m.object);
      })
      .catch(() => {});
  }
}
