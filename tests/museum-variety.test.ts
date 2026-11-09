import { test, expect } from './qa';
import './env';
import { loadMuseum, museum, themeMembers } from '../src/museumData';
import { collectionExits } from '../src/museum/destinations';
import { MuseumRoutes } from '../src/museum/routes';
import { partitionRooms } from '../src/museum/plan';
import { pageSize } from '../src/museum/style';

test('the museum catalogue contains every declared object exactly once and pagination preserves them', async () => {
  await loadMuseum();
  const data = museum(), ids = new Set<string>();
  let count = 0;
  for (const theme of data.themes) {
    const members = await themeMembers(theme.id);
    expect(members.length === theme.size, `${theme.id}: theme count differs from its members`);
    const pages = partitionRooms(members, () => null, pageSize(theme.collection));
    expect(pages.flat().length === members.length, `${theme.id}: pagination lost members`);
    for (const entry of pages.flat()) {
      const id = `${entry.ds}:${entry.id}`;
      expect(!ids.has(id), `duplicate catalogue object ${id}`);
      ids.add(id);
      count++;
    }
  }
  expect(count === data.total && count >= 79000, `expected the complete catalogue, found ${count}`);
  expect(new Set(data.themes.map((t) => t.collection)).size === 33, 'all 33 collections are represented');
});

test('every collection offers a distinct onward discovery while continuation and backtracking rules hold', async () => {
  await loadMuseum();
  const data = museum();
  const collections = [...new Set(data.themes.map((t) => t.collection))];
  for (const collection of collections) {
    const theme = data.themes.find((t) => t.collection === collection)!;
    const routes = new MuseumRoutes();
    const desc = { kind: 'gallery' as const, theme: theme.id, page: 0 };
    const exits = collectionExits(desc, theme, data.themes, 3, routes);
    expect(exits.length === 3, `${collection}: three onward routes`);
    expect(exits.some((e) => e.target.theme === theme.id && e.target.page === 1), `${collection}: continuation remains accessible`);
    expect(exits.some((e) => data.themes[e.target.theme].collection !== collection && e.top.startsWith('discover')), `${collection}: a different collection is reachable`);
    expect(new Set(exits.map((e) => `${e.target.theme}:${e.target.page}`)).size === 3, 'distinct destinations');
    expect(JSON.stringify(collectionExits(desc, theme, data.themes, 3, routes)) === JSON.stringify(exits), 'revisiting preserves destinations and their order');
    const other = exits.find((e) => e.target.theme !== theme.id)!;
    const onward = collectionExits(other.target, data.themes[other.target.theme], data.themes, 1, routes);
    expect(!onward.some((e) => e.target.theme === theme.id && e.target.page === 0), 'no forward A-B-A loop');
  }
});

test('discovery choices cover small collections as well as large CAD collections', async () => {
  await loadMuseum();
  const data = museum(), found = new Set<string>();
  for (const theme of data.themes.slice(0, 240)) {
    const routes = new MuseumRoutes();
    const exits = collectionExits({ kind: 'gallery', theme: theme.id, page: 0 }, theme, data.themes, 1, routes);
    for (const exit of exits.filter((e) => e.top.startsWith('discover'))) found.add(data.themes[exit.target.theme].collection);
  }
  expect(found.size >= 30, `discovery reached only ${found.size} collections`);
  expect(found.has('Power Tool') && found.has('Medical & Personal Care'), 'small and previously unfeatured collections can be discovered');
});
