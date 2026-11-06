/** Minimap (src/minimap.ts + the NYC source): deterministic tiles, correct player mapping, capped cache, throttled redraws. */
import { test, expect, near } from './qa';
import { Minimap, TileCache, worldToMap, registerMinimapSource, setSurfaceFactory, HUD_HZ, MAX_TILES, type Ctx2D, type Surface } from '../src/minimap';
import { nycMinimapSource } from '../src/nyc/minimap-nyc';

/** a 2D context that records every call and property write (for hashing what a tile paints) */
function recorder(log: string[]): Ctx2D {
  const target: Record<string, unknown> = {};
  return new Proxy(target, {
    get: (_t, k: string) => (k in target ? target[k] : (...a: unknown[]) => void log.push(`${k}(${a.map((v) => (typeof v === 'number' ? v.toFixed(2) : typeof v === 'object' ? 'img' : String(v))).join(',')})`)),
    set: (_t, k: string, v) => ((target[k] = v), log.push(`${k}=${v}`), true),
  }) as unknown as Ctx2D;
}
function surface(w: number, h: number, log: string[] = []): Surface {
  const g = recorder(log);
  return { width: w, height: h, getContext: () => g };
}
setSurfaceFactory((w, h) => surface(w, h));
const hash = (log: string[]) => { let h = 2166136261; for (const s of log) for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };

test('NYC tiles paint deterministically, and differ between places', () => {
  const paint = (tx: number, tz: number) => { const log: string[] = []; nycMinimapSource.drawTile(recorder(log), tx, tz, 256); return log; };
  const a = paint(0, -2), b = paint(0, -2), c = paint(5, 0);
  expect(a.length > 20, `tile paints only ${a.length} calls`);
  expect(hash(a) === hash(b), 'the same tile painted twice differs');
  expect(hash(a) !== hash(c), 'a park tile and an auto row tile paint the same');
});

test('the player arrow maps to the right place and heading', () => {
  // 10 m north of the player is straight up on a heading-up map when facing north (yaw 0)
  const [x1, y1] = worldToMap(100, 40, 100, 50, 0, 2, 90, 90);
  near(x1, 90, 1e-6, 'x'); near(y1, 70, 1e-6, 'y');
  // facing west (yaw +π/2): 10 m west is straight up, 10 m north is to the right
  const [x2, y2] = worldToMap(90, 50, 100, 50, Math.PI / 2, 2, 90, 90);
  near(x2, 90, 1e-6, 'west x'); near(y2, 70, 1e-6, 'west y');
  const [x3, y3] = worldToMap(100, 40, 100, 50, Math.PI / 2, 2, 90, 90);
  near(x3, 110, 1e-6, 'north x'); near(y3, 90, 1e-6, 'north y');
});

test(`the tile cache holds at most ${MAX_TILES} tiles and keeps recent ones (LRU)`, () => {
  const c = new TileCache();
  for (let i = 0; i < 200; i++) c.get(nycMinimapSource, i % 20, Math.floor(i / 20));
  expect(c.size <= MAX_TILES, `${c.size} tiles cached`);
  const p0 = c.painted;
  c.get(nycMinimapSource, 19, 9); // the last one: still cached
  expect(c.painted === p0, 'a recent tile was repainted');
  // new footprints for a block repaint the tiles over it
  nycMinimapSource.addChunk(2, 0, [{ rect: { minX: 200, maxX: 220, minZ: -20, maxZ: 20 } }]);
  c.get(nycMinimapSource, 1, 0);
  expect(c.painted > p0, 'a tile with new footprints was not repainted');
});

test(`the HUD redraws at most ${HUD_HZ} times a second, and not at all when the player stands still`, () => {
  const m = new Minimap();
  m.headless = surface(180, 180);
  const level = {};
  registerMinimapSource((l) => (l === level ? nycMinimapSource : null));
  const pos = { x: 49.8, z: 9 };
  for (let i = 0; i < 180; i++) m.update(level, pos, 0, i / 60); // 3 s standing still
  expect(m.stats.draws === 1, `${m.stats.draws} draws while standing still (want 1)`);
  for (let i = 0; i < 180; i++) { pos.z -= 0.08; m.update(level, pos, 0.001 * i, 3 + i / 60); } // 3 s walking
  expect(m.stats.draws <= 1 + 3 * HUD_HZ + 1, `${m.stats.draws} draws in 3 s of walking`);
  expect(m.stats.draws >= 3 * HUD_HZ * 0.8, `only ${m.stats.draws} draws while walking`);
  expect(m.cache.size <= MAX_TILES, 'cache over its cap');
  // a level without a source shows nothing and draws nothing
  const before = m.stats.draws;
  m.update({}, pos, 0, 10);
  expect(m.stats.draws === before, 'drew a map for a level with no source');
});
