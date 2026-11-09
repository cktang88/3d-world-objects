import type { LevelDesc } from '../level';

type Gallery = Extract<LevelDesc, { kind: 'gallery' }>;
export interface GalleryExit { label: string; top: string; target: Gallery }
const key = (d: Gallery) => `${d.theme}:${d.page}`;

/** A discovered room has one entrance. Only its explicit back door can revisit its parent. */
export class MuseumRoutes {
  private claimed = new Set<string>();
  private exits = new Map<string, GalleryExit[]>();

  reset(roots: Gallery[] = []) {
    this.claimed = new Set(roots.map(key));
    this.exits.clear();
  }

  choose(room: Gallery, candidates: Iterable<GalleryExit>, count = 3): GalleryExit[] {
    const id = key(room), existing = this.exits.get(id);
    if (existing) return [...existing];
    this.claimed.add(id);
    const selected: GalleryExit[] = [];
    for (const exit of candidates) {
      const next = key(exit.target);
      if (this.claimed.has(next)) continue;
      this.claimed.add(next);
      selected.push(exit);
      if (selected.length === count) break;
    }
    this.exits.set(id, [...selected]);
    return selected;
  }
}

export const museumRoutes = new MuseumRoutes();
