import * as THREE from 'three';
import { gltf, disposeDeep } from './detail';
import { addLods } from './meshlod'; // mesh-simplification: LOD chains for heavy scans

/**
 * Third-party 3D model libraries: catalogs in public/libraries/ (built by
 * scripts/libraries/build_catalogs.py), models streamed from each source's CORS-enabled CDN.
 *
 *   const hits = await searchLibrary({ source: 'gso', category: 'shoe', limit: 20 });
 *   const obj = await loadLibraryModel(hits[0]);          // metres, base at y=0, centred on x/z
 *   obj.userData.attribution                               // "“Title” by …, Source (licence)"
 *
 * Sources (see docs/research/libraries.md):
 *   polyhaven   Poly Haven models, CC0, ~520 photoreal props, furniture, plants, tools
 *   gso         Google Scanned Objects, CC BY 4.0, 1033 photo-scanned retail products
 *   smithsonian Smithsonian 3D Open Access, CC0, ~4000 museum objects, fossils, aircraft, space
 *   khronos     Khronos glTF Sample Assets, CC0 / CC BY 4.0, ~30 high-quality showcase models
 */

export type LibrarySource = 'polyhaven' | 'gso' | 'smithsonian' | 'khronos';
export const LIBRARY_SOURCES: LibrarySource[] = ['polyhaven', 'gso', 'smithsonian', 'khronos'];

export interface LibraryEntry {
  source: LibrarySource;
  id: string;
  title: string;
  category: string;
  tags: string[];
  licence: string;
  author: string;
  /** model file (GLB), or for Poly Haven the asset's file-list API URL */
  url: string;
  /** real-world size [x, y(up), z] in metres when known */
  size?: [number, number, number];
  thumb?: string;
  tris?: number;
  /** approximate download size in KB when known */
  kb?: number;
  /** human-readable page for credits */
  page: string;
  /** Smithsonian EDAN record id (fetch full museum metadata from api.si.edu with an api.data.gov key) */
  edan?: string;
  /** model parts with their placement (Smithsonian Voyager packages); url is the first part */
  parts?: { url: string; unit: number; q?: [number, number, number, number]; t?: [number, number, number]; lowUrl?: string }[];
}

export interface LibraryInfo {
  source: LibrarySource;
  name: string;
  licence: string;
  home: string;
  count: number;
  credit: string;
  /** categories with entry counts */
  categories: Record<string, number>;
}

interface RawEntry {
  id: string;
  t: string;
  c: string;
  tags?: string[];
  lic?: string;
  by?: string;
  u?: string;
  s?: [number, number, number];
  th?: string;
  tri?: number;
  /** Smithsonian: model rotation (x,y,z,w), metres per unit, multi-part models, EDAN record */
  q?: [number, number, number, number];
  f?: number;
  parts?: { u: string; f: number; q?: [number, number, number, number]; t?: [number, number, number]; lo?: string }[];
  edan?: string;
  kb?: number;
  lo?: string;
}
interface RawCatalog {
  source: LibrarySource;
  name: string;
  licence: string;
  home: string;
  credit: string;
  base: string;
  tpl?: { u?: string; th?: string; lod?: string };
  entries?: RawEntry[];
  shards?: { c: string; n: number }[];
}

const BASE = `${import.meta.env.BASE_URL}libraries/`;
const jsonCache = new Map<string, Promise<RawCatalog>>();
function fetchJson(path: string): Promise<RawCatalog> {
  let p = jsonCache.get(path);
  if (!p) {
    p = fetch(BASE + path).then((r) => {
      if (!r.ok) throw new Error(`library catalog ${path}: ${r.status}`);
      return r.json();
    });
    jsonCache.set(path, p);
  }
  return p;
}

const PAGES: Record<LibrarySource, (id: string) => string> = {
  polyhaven: (id) => `https://polyhaven.com/a/${id}`,
  gso: (id) => `https://app.gazebosim.org/GoogleResearch/fuel/models/${id}`,
  smithsonian: (id) => `https://3d-api.si.edu/voyager/3d_package:${id}`,
  khronos: (id) => `https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/${id}`,
};

function abs(base: string, u: string) {
  return /^https?:/.test(u) ? u : base + u;
}
function fill(tpl: string, id: string) {
  return tpl.replace(/\{id\}/g, id);
}

function toEntry(cat: RawCatalog, e: RawEntry): LibraryEntry {
  const parts = e.parts
    ? e.parts.map((p) => ({ url: abs(cat.base, p.u), unit: p.f, q: p.q, t: p.t, lowUrl: p.lo ? abs(cat.base, p.lo) : undefined }))
    : e.f !== undefined || e.q
      ? [{ url: abs(cat.base, e.u!), unit: e.f ?? 1, q: e.q, lowUrl: e.lo ? abs(cat.base, e.lo) : undefined }]
      : undefined;
  const u = e.u ?? e.parts?.[0]?.u ?? fill(cat.tpl?.u ?? '{id}', e.id);
  const th = e.th ?? (cat.tpl?.th ? fill(cat.tpl.th, e.id) : undefined);
  return {
    source: cat.source,
    id: e.id,
    title: e.t,
    category: e.c,
    tags: e.tags ?? [],
    licence: e.lic ?? cat.licence,
    author: e.by ?? '',
    url: abs(cat.base, u),
    size: e.s,
    thumb: th ? abs(cat.base, th) : undefined,
    tris: e.tri,
    kb: e.kb,
    page: PAGES[cat.source](e.id),
    edan: e.edan,
    parts,
  };
}

/**
 * All entries of a source (or only one category: cheaper for the sharded Smithsonian catalog).
 */
export async function loadCatalog(source: LibrarySource, category?: string): Promise<LibraryEntry[]> {
  if (source === 'smithsonian') {
    const idx = await fetchJson('smithsonian/index.json');
    const shards = (idx.shards ?? []).filter((s) => !category || s.c === category);
    const cats = await Promise.all(shards.map((s) => fetchJson(`smithsonian/${s.c}.json`)));
    return cats.flatMap((c) => (c.entries ?? []).map((e) => toEntry(c, e)));
  }
  const cat = await fetchJson(`${source}.json`);
  const all = (cat.entries ?? []).map((e) => toEntry(cat, e));
  return category ? all.filter((e) => e.category === category) : all;
}

/** Name, licence, size and categories of each source (Smithsonian loads only its index). */
export async function libraryInfo(source: LibrarySource): Promise<LibraryInfo> {
  const file = source === 'smithsonian' ? 'smithsonian/index.json' : `${source}.json`;
  const c = await fetchJson(file);
  const categories: Record<string, number> = {};
  if (c.shards) for (const s of c.shards) categories[s.c] = s.n;
  else for (const e of c.entries ?? []) categories[e.c] = (categories[e.c] ?? 0) + 1;
  const count = Object.values(categories).reduce((a, b) => a + b, 0);
  return { source, name: c.name, licence: c.licence, home: c.home, credit: c.credit, count, categories };
}

export interface LibraryQuery {
  source?: LibrarySource | LibrarySource[];
  /** exact category (see libraryInfo().categories) */
  category?: string | string[];
  /** words that must all appear in title, category or tags (case-insensitive) */
  text?: string;
  /** any of these words in title/tags */
  anyOf?: string[];
  /** largest dimension bounds in metres (entries with unknown size pass) */
  minSize?: number;
  maxSize?: number;
  /** skip models heavier than this many triangles when known */
  maxTris?: number;
  limit?: number;
  /** deterministic shuffle seed; omitted keeps catalog order */
  seed?: number;
}

/** Search one or several catalogs. */
export async function searchLibrary(q: LibraryQuery = {}): Promise<LibraryEntry[]> {
  const sources = q.source ? ([] as LibrarySource[]).concat(q.source) : LIBRARY_SOURCES;
  const cats = q.category ? ([] as string[]).concat(q.category) : null;
  const loaded = await Promise.all(
    sources.map((s) => (s === 'smithsonian' && cats?.length === 1 ? loadCatalog(s, cats[0]) : loadCatalog(s))),
  );
  const words = (q.text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const any = (q.anyOf ?? []).map((w) => w.toLowerCase());
  let out = loaded.flat().filter((e) => {
    if (cats && !cats.includes(e.category)) return false;
    const hay = `${e.title} ${e.category} ${e.tags.join(' ')} ${e.id}`.toLowerCase();
    if (words.some((w) => !hay.includes(w))) return false;
    if (any.length && !any.some((w) => hay.includes(w))) return false;
    if (e.size) {
      const m = Math.max(...e.size);
      if (q.minSize !== undefined && m < q.minSize) return false;
      if (q.maxSize !== undefined && m > q.maxSize) return false;
    }
    if (q.maxTris !== undefined && e.tris && e.tris > q.maxTris) return false;
    return true;
  });
  if (q.seed !== undefined) {
    let s = q.seed >>> 0 || 1;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    out = out.map((e) => [rnd(), e] as const).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  }
  return q.limit ? out.slice(0, q.limit) : out;
}

/** One-line credit for UI and CREDITS lists. */
export function attribution(e: LibraryEntry): string {
  const names: Record<LibrarySource, string> = {
    polyhaven: 'Poly Haven',
    gso: 'Google Scanned Objects (Google Research)',
    smithsonian: 'Smithsonian Institution Open Access',
    khronos: 'Khronos glTF Sample Assets',
  };
  return `“${e.title}”${e.author ? ` by ${e.author}` : ''}, ${names[e.source]}, ${e.licence}, ${e.page}`;
}

// ---------------------------------------------------------------------------------- loading

export interface LoadOptions {
  /** scale so the model is this tall (metres) instead of its real size */
  height?: number;
  /** scale so the largest dimension is this (metres) */
  maxDim?: number;
  /** Poly Haven texture resolution (default 1k) */
  resolution?: '1k' | '2k' | '4k';
  /** Google Scanned Objects simplified level 1..3 (default 0 = full) */
  lod?: 0 | 1 | 2 | 3;
  /** 'low': cheap version for distance or crowds (Smithsonian ~20k-face Thumb GLB, GSO lod 2, Poly Haven 1k) */
  quality?: 'full' | 'low';
  /** cast/receive shadows (default true) */
  shadows?: boolean;
}

interface Loaded {
  scene: THREE.Object3D;
  box: THREE.Box3;
}
const modelCache = new Map<string, Promise<Loaded>>();
/** the copies handed out per cached model (weak: a dropped copy does not keep its model alive) */
const copies = new Map<string, WeakRef<THREE.Object3D>[]>();
/** cached models kept with no copy in use; past this the least recently used unused ones are freed */
const UNUSED_MAX = 24;
/** is any copy of this model still in a live scene? (disposeTree marks a dropped level's nodes disposed) */
function inUse(key: string) {
  const list = (copies.get(key) ?? []).filter((r) => {
    const o = r.deref();
    return !!o && !o.userData.disposed;
  });
  copies.set(key, list);
  return list.length > 0;
}
/** free the GPU data of cached models nobody uses, oldest first, beyond UNUSED_MAX */
function trimModels() {
  const unused = [...modelCache.keys()].filter((k) => !inUse(k));
  for (const key of unused.slice(0, Math.max(0, unused.length - UNUSED_MAX))) {
    const p = modelCache.get(key)!;
    modelCache.delete(key);
    copies.delete(key);
    p.then((l) => disposeDeep(l.scene), () => undefined);
  }
}

async function parseGltf(data: ArrayBuffer | string, path: string): Promise<THREE.Object3D> {
  const l = gltf();
  if (!l) throw new Error('libraries: initDetail(renderer) has not run');
  const g = await l.parseAsync(data, path);
  return g.scene;
}

async function fetchModel(e: LibraryEntry, opts: LoadOptions): Promise<THREE.Object3D> {
  if (e.source === 'polyhaven') {
    // the glTF's relative texture paths do not match the CDN layout: rewrite them from the file list
    const files = await (await fetch(e.url)).json();
    const res = opts.resolution ?? '1k';
    const g = (files.gltf?.[res] ?? files.gltf?.['1k'] ?? Object.values(files.gltf ?? {})[0])?.gltf;
    if (!g) throw new Error(`no glTF for ${e.id}`);
    const doc = await (await fetch(g.url)).json();
    const inc: Record<string, { url: string }> = g.include ?? {};
    const fix = (uri: string) => inc[decodeURIComponent(uri)]?.url ?? inc[uri]?.url ?? new URL(uri, g.url).href;
    for (const b of doc.buffers ?? []) if (b.uri) b.uri = fix(b.uri);
    for (const im of doc.images ?? []) if (im.uri) im.uri = fix(im.uri);
    return parseGltf(JSON.stringify(doc), '');
  }
  if (e.parts) {
    // Voyager packages: each part carries its own units, rotation and offset
    const g = new THREE.Group();
    const low = opts.quality === 'low';
    const scenes = await Promise.all(e.parts.map((p) => fetchGlb(low && p.lowUrl ? p.lowUrl : p.url)));
    e.parts.forEach((p, i) => {
      const holder = new THREE.Group();
      const sc = scenes[i];
      if (p.q) sc.quaternion.set(p.q[0], p.q[1], p.q[2], p.q[3]);
      if (p.t) sc.position.set(p.t[0], p.t[1], p.t[2]);
      holder.scale.setScalar(p.unit);
      holder.add(sc);
      g.add(holder);
    });
    return g;
  }
  let url = e.url;
  const lod = opts.lod ?? (opts.quality === 'low' ? 2 : 0);
  if (e.source === 'gso' && lod) url = url.replace(/objects\/([^/]+)\/\1\.glb$/, `lods/$1/$1_lod${lod}.glb`);
  return fetchGlb(url);
}

async function fetchGlb(url: string): Promise<THREE.Object3D> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return parseGltf(await r.arrayBuffer(), url.replace(/[^/]*$/, ''));
}

function cacheKey(e: LibraryEntry, o: LoadOptions) {
  return `${e.source}:${e.id}:${o.resolution ?? ''}:${o.lod ?? 0}:${o.quality ?? 'full'}`;
}

/**
 * Load a catalog entry as an Object3D in metres, centred on x/z with its base at y=0.
 * Models are cached per entry: each call returns a clone sharing geometry and materials.
 * userData: { library: entry, attribution, size: Vector3 }.
 */
export async function loadLibraryModel(e: LibraryEntry, opts: LoadOptions = {}): Promise<THREE.Group> {
  const key = cacheKey(e, opts);
  let p = modelCache.get(key);
  if (!p) {
    p = fetchModel(e, opts).then(async (scene) => {
      // mesh-simplification: full-quality scans (up to ~1M tris) get 25 % / 6 % screen-space-error levels
      if (opts.quality !== 'low') await addLods(scene).catch(() => 0);
      scene.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(scene);
      const shadows = opts.shadows !== false;
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.castShadow = shadows;
          m.receiveShadow = shadows;
        }
      });
      return { scene, box };
    });
    modelCache.set(key, p);
    p.catch(() => modelCache.delete(key));
    trimModels();
  } else {
    modelCache.delete(key);
    modelCache.set(key, p); // LRU bump
  }
  const { scene, box } = await p;
  // freed while we waited (trimModels): load it afresh
  if (modelCache.get(key) !== p) return loadLibraryModel(e, opts);
  const raw = box.getSize(new THREE.Vector3());
  const rawMax = Math.max(raw.x, raw.y, raw.z, 1e-6);
  let s = 1;
  if (opts.height) s = opts.height / Math.max(raw.y, 1e-6);
  else if (opts.maxDim) s = opts.maxDim / rawMax;
  else if (e.size) s = Math.max(...e.size) / rawMax;
  else if (rawMax > 30 && e.category !== 'architecture') s = 0.001; // millimetre scans
  const c = box.getCenter(new THREE.Vector3());
  const inner = scene.clone(true);
  inner.position.set(-c.x, -box.min.y, -c.z);
  const g = new THREE.Group();
  g.name = `${e.source}:${e.id}`;
  g.scale.setScalar(s);
  g.add(inner);
  g.userData.library = e;
  g.userData.attribution = attribution(e);
  g.userData.size = raw.clone().multiplyScalar(s);
  const list = copies.get(key) ?? [];
  list.push(new WeakRef(inner));
  copies.set(key, list);
  return g;
}

/** Drop a cached model (and free its GPU data once no clones use it). */
export async function evictLibraryModel(e: LibraryEntry, opts: LoadOptions = {}) {
  const key = cacheKey(e, opts);
  const p = modelCache.get(key);
  modelCache.delete(key);
  copies.delete(key);
  if (p) disposeDeep((await p).scene);
}
