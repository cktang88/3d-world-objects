import type { RemoteEntry } from './remote';

/** themes.json: the similarity graph built by scripts/build_museum.py */
export interface Theme {
  id: number;
  name: string;
  collection: string;
  size: number;
  neighbors: number[];
  shard: number;
  words: string[];
}

export interface Wing {
  name: string;
  blurb: string;
  theme: number;
  preview: RemoteEntry[];
}

interface ThemesFile {
  total: number;
  collections: string[];
  themes: [string, number, number, number[], number, string][];
  wings: { name: string; blurb: string; theme: number; preview: RemoteEntry[] | unknown[][] }[];
  shardSize: number;
}

let data: { total: number; themes: Theme[]; wings: Wing[] } | null = null;
const shards = new Map<number, Promise<Record<string, unknown[][]>>>();

export function toEntry(a: unknown[]): RemoteEntry {
  const [ds, split, row, id, family, entry, title, author, url, license, path, bytes, f, joints, og] = a as [string, string, number, string, string, string, string, string, string, string, string, number, number, number, number];
  return { ds, split, row, id, family, entry, title, author, url, license, path, bytes, f, joints, og: og || 0 };
}

export async function loadMuseum() {
  if (data) return data;
  const res = await fetch(`${import.meta.env.BASE_URL}museum/themes.json`);
  const f = (await res.json()) as ThemesFile;
  const themes: Theme[] = f.themes.map(([name, ci, size, neighbors, shard, words], id) => ({
    id, name, collection: f.collections[ci], size, neighbors, shard, words: words ? words.split(' ') : [],
  }));
  const wings: Wing[] = f.wings.map((w) => ({ name: w.name, blurb: w.blurb, theme: w.theme, preview: (w.preview as unknown[][]).map(toEntry) }));
  data = { total: f.total, themes, wings };
  return data;
}

export function museum() {
  if (!data) throw new Error('museum not loaded');
  return data;
}

export async function themeMembers(id: number): Promise<RemoteEntry[]> {
  const t = museum().themes[id];
  let p = shards.get(t.shard);
  if (!p) {
    p = fetch(`${import.meta.env.BASE_URL}museum/t/${t.shard}.json`).then((r) => r.json());
    shards.set(t.shard, p);
  }
  const s = await p;
  return (s[String(id)] ?? []).map(toEntry);
}

/** store pools for the world mode's shops: family -> objects */
let pools: Promise<Record<string, RemoteEntry[]>> | null = null;
export function loadPools() {
  pools ??= fetch(`${import.meta.env.BASE_URL}museum/pools.json`)
    .then((r) => r.json())
    .then((raw: Record<string, unknown[][]>) => {
      const out: Record<string, RemoteEntry[]> = {};
      for (const k of Object.keys(raw)) out[k] = raw[k].map(toEntry);
      return out;
    });
  return pools;
}
