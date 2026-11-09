import type { Theme } from '../museumData';
import type { LevelDesc } from '../level';
import { Rng, hashN } from '../rng';
import { museumRoutes, type MuseumRoutes, type GalleryExit } from './routes';

type Gallery = Extract<LevelDesc, { kind: 'gallery' }>;

/** Keep a thematic path, but offer a different collection on every onward visit. Discovery
 * draws collections equally, so 22k CAD parts don't drown out smaller collections. */
export function collectionExits(desc: Gallery, theme: Theme, themes: Theme[], pages: number, routes: MuseumRoutes = museumRoutes): GalleryExit[] {
  const rng = new Rng(hashN(desc.theme, desc.page, 7));
  const exit = (t: Theme, top: string): GalleryExit => ({ top, label: t.name, target: { kind: 'gallery', theme: t.id, page: 0, wing: desc.wing } });
  const neighbours = theme.neighbors.map((id) => themes[id]).filter((t) => t && t.id !== theme.id);
  const related = [...neighbours, ...rng.shuffle(themes.filter((t) => t.collection === theme.collection && t.id !== theme.id))].map((t) => exit(t, 'similar'));
  const collections = rng.shuffle([...new Set(themes.map((t) => t.collection))].filter((c) => c !== theme.collection));
  const discovery = collections.flatMap((collection) => rng.shuffle(themes.filter((t) => t.collection === collection)).map((t) => exit(t, `discover · ${collection}`)));
  const fallback = [...related, ...discovery];
  const continuation: GalleryExit[] = desc.page + 1 < pages ? [{ top: 'continue', label: `${theme.name} · ${desc.page + 2}`, target: { ...desc, page: desc.page + 1 } }] : [];
  return rng.shuffle(routes.chooseDirections(desc, [continuation.length ? [...continuation, ...fallback] : fallback, fallback, [...discovery, ...related]]));
}
