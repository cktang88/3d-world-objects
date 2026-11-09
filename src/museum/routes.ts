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

  available(room: Gallery) { return !this.claimed.has(key(room)); }

  /** Reserve a destination for each purpose (continue, similar, discover), not just the
   * first three neighbours. A long list of similar themes must not crowd out discovery. */
  chooseDirections(room: Gallery, directions: Iterable<GalleryExit>[]): GalleryExit[] {
    const id = key(room), existing = this.exits.get(id);
    if (existing) return [...existing];
    this.claimed.add(id);
    const selected: GalleryExit[] = [];
    for (const candidates of directions) for (const exit of candidates) {
      if (!this.available(exit.target)) continue;
      this.claimed.add(key(exit.target));
      selected.push(exit);
      break;
    }
    this.exits.set(id, [...selected]);
    return selected;
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
