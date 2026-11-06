import * as THREE from 'three';
import { loadCatalog, loadLibraryModel, type LibraryEntry } from '../libraries';
import type { Theme } from '../museumData';
import type { RemoteEntry, RemoteModel } from '../remote';
import type { Measured } from './sizes';
import type { Arch } from './style';

/**
 * Smithsonian galleries: real museum scans (Smithsonian 3D Open Access, CC0, via src/libraries.ts)
 * at their real dimensions, laid out by the same planner as the sand3d rooms. They live in the
 * gallery desc's theme space above SI_BASE so no shared level type has to change.
 */
export const SI_BASE = 100000;

interface SiRoom {
  name: string;
  cats: string[];
  arch: Arch;
  blurb: string;
  /** plausible largest dimension per category (scans with broken units are left out) */
  max: number;
  /** a related sand3d collection, for the doorway back into the sand3d rooms */
  related?: string;
  exclude?: RegExp;
}

export const SI_ROOMS: SiRoom[] = [
  { name: 'Milestones of Flight', cats: ['air-space'], arch: 'hangar', blurb: 'Real aircraft and spacecraft, scanned by the Smithsonian', max: 45, related: 'Aircraft & Spacecraft' },
  { name: 'Sculpture Court', cats: ['art', 'portraits'], arch: 'period', blurb: 'Statues and busts from the American art collections', max: 4.5, related: 'Architectural Element' },
  { name: 'Arts of Asia and Africa', cats: ['asian-art', 'african-art'], arch: 'treasury', blurb: 'Bronzes, porcelain and paintings from the Freer and Sackler galleries', max: 4, related: 'Container' },
  { name: 'Fossil Hall', cats: ['fossil', 'bone'], arch: 'machine', blurb: 'Fossils, skeletons and skulls from the National Museum of Natural History', max: 10, related: 'Animal Gear' },
  { name: 'Shells and Corals', cats: ['shell', 'coral'], arch: 'study', blurb: 'Mollusc shells and corals, cabinet by cabinet', max: 0.8, related: 'Tableware' },
  { name: 'Natural History Specimens', cats: ['specimen', 'animal'], arch: 'study', blurb: 'Plants, insects and animals from the research collections', max: 6, related: 'Garden & Outdoor' },
  { name: 'American Stories', cats: ['american-history', 'african-american', 'postal'], arch: 'period', blurb: 'Objects from the National Museum of American History and the NMAAHC', max: 8, related: 'Stationery' },
  { name: 'Cooper Hewitt Design', cats: ['design'], arch: 'whitecube', blurb: 'Chairs and objects from the Smithsonian design museum', max: 3, related: 'Furniture', exclude: /floor|mansion/i },
];

export function isSi(theme: number) {
  return theme >= SI_BASE && theme < SI_BASE + SI_ROOMS.length;
}

const members = new Map<number, Promise<LibraryEntry[]>>();
export function siEntries(theme: number): Promise<LibraryEntry[]> {
  let p = members.get(theme);
  if (!p) {
    const room = SI_ROOMS[theme - SI_BASE];
    p = Promise.all(room.cats.map((c) => loadCatalog('smithsonian', c).catch(() => [] as LibraryEntry[]))).then((ls) =>
      ls
        .flat()
        .filter((e) => e.size && Math.max(...e.size) <= room.max && Math.max(...e.size) >= 0.02 && !(room.exclude && room.exclude.test(e.title)))
        // the biggest first: the room's hero is its most imposing object
        .sort((a, b) => Math.max(...b.size!) - Math.max(...a.size!)),
    );
    members.set(theme, p);
  }
  return p;
}

/** a Theme-shaped record for the gallery (its size is known once the catalog has loaded) */
export function siTheme(theme: number, size = 24): Theme {
  const room = SI_ROOMS[theme - SI_BASE];
  return { id: theme, name: room.name, collection: 'Smithsonian Institution', size, neighbors: [], shard: -1, words: [] };
}

/** a library object as a measured exhibit: its size is known without loading it */
export function siMeasured(e: LibraryEntry, hero: boolean): Measured {
  const real = new THREE.Vector3(...e.size!);
  const entry: RemoteEntry = {
    ds: 'Smithsonian Open Access (CC0)', split: '', row: 0, id: `si:${e.id}`, family: e.category, entry: '', title: e.title, author: e.author || 'Smithsonian Institution',
    url: e.page, license: e.licence, path: '', bytes: 0, f: 0, joints: 0,
  };
  // the full scans are ~150k faces with 2k textures: only for a hero you can walk right up to
  const quality = hero && Math.max(real.x, real.y, real.z) < 5 ? 'full' : 'low';
  const loadQ = (q: 'low' | 'full') =>
    loadLibraryModel(e, { quality: q, shadows: false }).then((g): RemoteModel => {
      let tris = 0;
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.userData.shared = true; // geometry is shared with the library's cache
        tris += (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute('position').count) / 3;
      });
      return { object: g, size: real.clone(), animator: null, tris: Math.round(tris) };
    });
  return { entry, raw: real.clone(), k: 1, real, library: true, quality, loadQ, load: () => loadQ(quality) };
}
