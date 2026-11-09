import { test, expect } from './qa';
import { MuseumRoutes, type GalleryExit } from '../src/museum/routes';

const room = (theme: number, page = 0) => ({ kind: 'gallery' as const, theme, page });
const exit = (theme: number, page = 0): GalleryExit => ({ label: String(theme), top: 'similar', target: room(theme, page) });

test('onward doors cannot self-loop, duplicate another door, or return A-B-A', () => {
  const routes = new MuseumRoutes();
  const a = routes.choose(room(0), [exit(0), exit(1), exit(1), exit(2), exit(3)]);
  expect(a.map((e) => e.target.theme).join() === '1,2,3', 'three distinct forward rooms');
  const b = routes.choose(room(1), [exit(0), exit(1), exit(2), exit(4), exit(5), exit(6)]);
  expect(b.map((e) => e.target.theme).join() === '4,5,6', 'ancestors and sibling destinations excluded');
  expect(routes.choose(room(0), [exit(99)]).map((e) => e.target.theme).join() === '1,2,3', 'returning preserves the original door destinations');
});

test('page continuation is unique, wing entrances are reserved, exhaustion terminates and reset starts a new visit', () => {
  const routes = new MuseumRoutes();
  routes.reset([room(10), room(20)]);
  const a = routes.choose(room(10), [exit(20), exit(10, 1), exit(30), exit(31)]);
  expect(a.length === 3 && a[0].target.page === 1, 'continue opens a new page while another wing stays reserved');
  expect(routes.choose(room(30), [exit(10), exit(20), exit(31)]).length === 0, 'finite pool exhausted without a loop');
  routes.reset();
  expect(routes.choose(room(30), [exit(10)]).length === 1, 'a new museum visit resets assignments');
});

test('thousands of reciprocal graph edges produce a tree of unique discovered rooms', () => {
  const routes = new MuseumRoutes();
  const seen = new Set([0]), queue = [0];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    const candidates = Array.from({ length: 8 }, (_, j) => exit((id + j * 37 + 1) % 2000));
    candidates.unshift(exit(id), exit(Math.max(0, id - 1)));
    for (const e of routes.choose(room(id), candidates)) {
      expect(!seen.has(e.target.theme), `repeated forward room ${e.target.theme}`);
      seen.add(e.target.theme);
      queue.push(e.target.theme);
    }
  }
  expect(seen.size > 1000, 'a substantial connected graph was traversed');
});
