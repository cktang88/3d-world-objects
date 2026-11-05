import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Rng } from './rng';

export interface ModelEntry {
  id: string;
  role: string;
  family: string;
  file: string;
  title: string;
  entry: string | null;
  size: [number, number, number];
  tris: number;
  author: string | null;
  url: string | null;
  license: string | null;
  attribution: string | null;
}

let manifest: ModelEntry[] = [];
const byRole = new Map<string, ModelEntry[]>();

const FALLBACK: Record<string, string[]> = {
  sofa: ['bench', 'chair'],
  bed: ['sofa', 'bench'],
  bench: ['chair'],
  streetlamp: ['lamp'],
};

export async function loadManifest(): Promise<void> {
  const res = await fetch(`${import.meta.env.BASE_URL}models/manifest.json`);
  manifest = (await res.json()) as ModelEntry[];
  for (const e of manifest) {
    if (!byRole.has(e.role)) byRole.set(e.role, []);
    byRole.get(e.role)!.push(e);
  }
}

export function allModels(): ModelEntry[] {
  return manifest;
}

export function hasRole(role: string): boolean {
  return (byRole.get(role)?.length ?? 0) > 0;
}

export function pickModel(role: string, rng: Rng): ModelEntry | undefined {
  const list = byRole.get(role);
  if (list && list.length) return rng.pick(list);
  for (const alt of FALLBACK[role] ?? []) {
    const l = byRole.get(alt);
    if (l && l.length) return rng.pick(l);
  }
  return undefined;
}

/** How each role is measured and what plausible real-world range it should fall in (metres). */
interface Norm {
  m: 'h' | 'max' | 'horiz';
  min: number;
  max: number;
  target: number;
}
const NORMS: Record<string, Norm> = {
  building: { m: 'max', min: 6, max: 60, target: 18 },
  streetlamp: { m: 'h', min: 2.5, max: 8, target: 4.5 },
  plant: { m: 'h', min: 0.3, max: 2.5, target: 1.1 },
  bench: { m: 'horiz', min: 0.9, max: 2.6, target: 1.6 },
  vehicle: { m: 'horiz', min: 2.4, max: 9, target: 4.4 },
  streetprop: { m: 'h', min: 0.6, max: 3.5, target: 1.3 },
  chair: { m: 'h', min: 0.6, max: 1.3, target: 0.92 },
  table: { m: 'h', min: 0.5, max: 1.1, target: 0.76 },
  sofa: { m: 'horiz', min: 1.2, max: 2.8, target: 2.0 },
  bed: { m: 'horiz', min: 1.6, max: 2.6, target: 2.05 },
  storage: { m: 'h', min: 0.5, max: 2.4, target: 1.6 },
  lamp: { m: 'h', min: 0.25, max: 2.2, target: 1.5 },
  electronics: { m: 'max', min: 0.08, max: 1.4, target: 0.45 },
  appliance: { m: 'h', min: 0.2, max: 2.0, target: 0.9 },
  tableware: { m: 'max', min: 0.05, max: 0.45, target: 0.18 },
  food: { m: 'max', min: 0.04, max: 0.45, target: 0.16 },
  toy: { m: 'max', min: 0.08, max: 0.8, target: 0.3 },
  stationery: { m: 'max', min: 0.05, max: 0.45, target: 0.2 },
  container: { m: 'max', min: 0.2, max: 1.2, target: 0.55 },
  instrument: { m: 'max', min: 0.4, max: 1.9, target: 1.1 },
  tool: { m: 'max', min: 0.1, max: 0.8, target: 0.3 },
  bathroom: { m: 'h', min: 0.35, max: 2.2, target: 0.85 },
  sports: { m: 'max', min: 0.15, max: 1.5, target: 0.5 },
  craft: { m: 'max', min: 0.3, max: 0.9, target: 0.6 },
  gear: { m: 'max', min: 0.4, max: 1.9, target: 1.0 },
  machine: { m: 'h', min: 0.5, max: 2.4, target: 1.3 },
};

function measure(size: readonly number[], m: Norm['m']): number {
  if (m === 'h') return size[1];
  if (m === 'horiz') return Math.max(size[0], size[2]);
  return Math.max(size[0], size[1], size[2]);
}

/** Scale that brings a model into its role's plausible range. */
export function normScale(e: ModelEntry, role = e.role): number {
  const n = NORMS[role] ?? NORMS[e.role];
  if (!n) return 1;
  const v = measure(e.size, n.m);
  if (v <= 0) return 1;
  if (v < n.min || v > n.max) return n.target / v;
  return 1;
}

/** Scale so the model's measure equals `value`. */
export function scaleTo(e: ModelEntry, value: number, m: Norm['m'] = 'max'): number {
  const v = measure(e.size, m);
  return v > 0 ? value / v : 1;
}

const loader = new GLTFLoader();
const cache = new Map<string, Promise<THREE.Object3D>>();

function load(file: string): Promise<THREE.Object3D> {
  let p = cache.get(file);
  if (!p) {
    p = loader.loadAsync(`${import.meta.env.BASE_URL}models/${file}`).then((g) => {
      g.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.castShadow = true;
          m.receiveShadow = true;
          const mat = m.material as THREE.MeshStandardMaterial;
          if (mat && mat.transparent) mat.depthWrite = false;
        }
      });
      return g.scene;
    });
    cache.set(file, p);
  }
  return p;
}

export interface Spawned {
  obj: THREE.Group;
  /** scaled size before rotation: x, y, z */
  size: THREE.Vector3;
  entry: ModelEntry;
}

/**
 * Create a placeholder group for a model right away; the mesh streams in when loaded.
 * Placement and collisions only need the manifest's size, so worlds generate synchronously.
 */
export function spawn(e: ModelEntry, scale = normScale(e)): Spawned {
  const obj = new THREE.Group();
  obj.name = e.title;
  obj.userData.entry = e;
  const inner = new THREE.Group();
  inner.scale.setScalar(scale);
  obj.add(inner);
  load(e.file)
    .then((scene) => {
      if (obj.userData.disposed) return;
      inner.add(scene.clone());
    })
    .catch((err) => console.warn('model failed', e.file, err));
  return { obj, size: new THREE.Vector3(e.size[0] * scale, e.size[1] * scale, e.size[2] * scale), entry: e };
}

export function preload(files: string[]): Promise<unknown> {
  return Promise.all(files.map((f) => load(f).catch(() => null)));
}
