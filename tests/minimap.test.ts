/** Minimap (src/minimap.ts + the NYC source): deterministic tiles, correct player mapping, capped cache, throttled redraws. */
import { test, expect, near, none, fmt } from './qa';
import { Minimap, TileCache, worldToMap, largeToWorld, worldToLarge, registerMinimapSource, setSurfaceFactory, HUD_HZ, MAX_TILES, type Ctx2D, type Surface } from '../src/minimap';
import { nycMinimapSource } from '../src/nyc/minimap-nyc';
import { districtAt, walkable } from '../src/nyc/districts';
import { AX, SZ, BX, BZ, LX, LZ } from '../src/nyc/common';

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
  for (let i = 0; i < 180; i++) m.update(level, pos, 0, i / 60); // 3 s standing still: tiles fill in one per draw, then nothing
  const filled = m.stats.draws;
  expect(filled <= 12, `${filled} draws to fill the view`);
  for (let i = 0; i < 180; i++) m.update(level, pos, 0, 3 + i / 60);
  expect(m.stats.draws === filled, `${m.stats.draws - filled} more draws while standing still (want 0)`);
  for (let i = 0; i < 180; i++) { pos.z -= 0.08; m.update(level, pos, 0.001 * i, 6 + i / 60); } // 3 s walking
  expect(m.stats.draws - filled <= 3 * HUD_HZ + 1, `${m.stats.draws} draws in 3 s of walking`);
  expect(m.stats.draws - filled >= 3 * HUD_HZ * 0.8, `only ${m.stats.draws} draws while walking`);
  expect(m.cache.size <= MAX_TILES, 'cache over its cap');
  // a level without a source shows nothing and draws nothing
  const before = m.stats.draws;
  m.update({}, pos, 0, 10);
  expect(m.stats.draws === before, 'drew a map for a level with no source');
});

test('large map: click -> world round-trips with world -> map', () => {
  for (const [x, z] of [[0, 0], [529.8, -320], [-310, -128], [12.5, -7.25]]) {
    const [sx, sy] = worldToLarge(x, z, 100, -50, 0.75, 960, 540);
    const [wx, wz] = largeToWorld(sx, sy, 100, -50, 0.75, 960, 540);
    near(wx, x, 1e-9, 'x'); near(wz, z, 1e-9, 'z');
  }
});

test('teleport spots are walkable, on a sidewalk or path, never in a building or the roadway', () => {
  const bad: string[] = [];
  let n = 0;
  for (let z = -7 * SZ; z <= 3 * SZ; z += 13.7)
    for (let x = -4 * AX; x <= 7 * AX; x += 17.3) {
      const to = nycMinimapSource.snap!(x, z);
      if (!to) { bad.push(`${fmt(x)},${fmt(z)}: no spot`); continue; }
      n++;
      const cx = Math.round(to.x / AX), cz = Math.round(to.z / SZ), lx = to.x - cx * AX, lz = to.z - cz * SZ;
      const d = districtAt(cx, cz);
      if (!walkable(to.x, to.z)) bad.push(`${fmt(x)},${fmt(z)} -> ${fmt(to.x)},${fmt(to.z)} not walkable`);
      else if (!d.open && Math.abs(lx) < LX && Math.abs(lz) < LZ) bad.push(`${fmt(x)},${fmt(z)} -> inside a ${d.kind} block`);
      else if (!d.open && (Math.abs(lx) > BX || Math.abs(lz) > BZ)) bad.push(`${fmt(x)},${fmt(z)} -> in the roadway`);
      else if (Math.hypot(to.x - x, to.z - z) > (walkable(x, z) ? 40 : 200)) bad.push(`${fmt(x)},${fmt(z)} -> ${fmt(Math.hypot(to.x - x, to.z - z))} m away`);
    }
  expect(n > 300, `only ${n} spots`);
  none(bad, 'bad teleport spots');
});

test('a click on a showcase marker lands in that block, facing the showcase', () => {
  const m = new Minimap();
  m.headless = surface(960, 540);
  const level = {};
  registerMinimapSource((l) => (l === level ? nycMinimapSource : null));
  let went: [number, number, number] | null = null;
  m.onTeleport = (x, z, yaw) => (went = [x, z, yaw]);
  m.update(level, { x: 300, z: -200 }, 0, 0);
  m.cycle(); // large map, centred on the player
  m.update(level, { x: 300, z: -200 }, 0, 0.1);
  const bad: string[] = [];
  let tried = 0;
  for (const l of nycMinimapSource.labels!(-100, -500, 700, 100).filter((l) => l.kind === 'showcase')) {
    const { ppm, W, H } = m.large;
    const [sx, sy] = worldToLarge(l.x, l.z, 300, -200, ppm, W, H);
    if (sx < 0 || sy < 0 || sx > W || sy > H) continue;
    went = null;
    m.mode = 'large';
    m.update(level, { x: 300, z: -200 }, 0, 1 + tried); // redraw: markers in place
    m.clickLarge(sx, sy);
    tried++;
    if (!went) { bad.push(`${l.text}: no teleport`); continue; }
    const [x, z, yaw] = went as [number, number, number];
    const cx = Math.round(l.x / AX), cz = Math.round(l.z / SZ);
    if (Math.abs(x - cx * AX) > AX / 2 + 0.01 || Math.abs(z - cz * SZ) > SZ / 2 + 0.01) bad.push(`${l.text} at ${cx},${cz}: landed at ${fmt(x)},${fmt(z)} (outside its block)`);
    if (!walkable(x, z)) bad.push(`${l.text}: landed on an unwalkable spot`);
    // facing the block's centre (yaw 0 looks -z)
    const want = Math.atan2(-(cx * AX - x), -(cz * SZ - z));
    if (Math.abs(Math.atan2(Math.sin(yaw - want), Math.cos(yaw - want))) > 0.05) bad.push(`${l.text}: not facing its showcase`);
    if (m.mode !== 'hud') bad.push('the large map stayed open after a teleport');
  }
  expect(tried >= 5, `only ${tried} markers clicked`);
  none(bad, 'marker teleports');
});
