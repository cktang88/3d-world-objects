/** Minimap (src/minimap.ts + the NYC source): deterministic tiles, correct player mapping, capped cache, throttled redraws. */
import { test, expect, near, none, fmt } from './qa';
import { Minimap, TileCache, worldToMap, largeToWorld, worldToLarge, registerMinimapSource, setSurfaceFactory, MAX_TILES, HUD_MAP, RECOMPOSITE_M, type Ctx2D, type Surface } from '../src/minimap';
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

test(`the HUD rebuilds its map only every ${RECOMPOSITE_M} m (or to fill a tile), and only moves a CSS transform per frame`, () => {
  const m = new Minimap();
  m.headless = surface(HUD_MAP, HUD_MAP);
  const level = {};
  registerMinimapSource((l) => (l === level ? nycMinimapSource : null));
  const pos = { x: 49.8, z: 9 };
  for (let i = 0; i < 180; i++) m.update(level, pos, 0, i / 60); // 3 s standing still: tiles fill in one per composite
  const filled = m.stats.composites;
  expect(filled <= 16, `${filled} composites to fill the view`);
  for (let i = 0; i < 180; i++) m.update(level, pos, 0, 3 + i / 60);
  expect(m.stats.composites === filled, `${m.stats.composites - filled} more composites while standing still (want 0)`);
  // 3 s walking north at 4.8 m/s (14.4 m) while turning: at most 2 rebuilds, the transform follows every frame
  const tfs = new Set<string>();
  for (let i = 0; i < 180; i++) { pos.z -= 0.08; m.update(level, pos, 0.002 * i, 6 + i / 60); tfs.add(m.hudTransform); }
  expect(m.stats.composites - filled <= 3, `${m.stats.composites - filled} composites in 3 s of walking`);
  expect(tfs.size >= 170, `the CSS transform changed only ${tfs.size} times in 180 frames`);
  // the transform keeps the player at the HUD centre: rotate(yaw) about it
  expect(m.hudTransform.startsWith('translate(90px,90px) rotate('), m.hudTransform);
  expect(m.stats.frameMs < 0.3, `update() costs ${m.stats.frameMs} ms a frame on average`);
  expect(m.cache.size <= MAX_TILES, 'cache over its cap');
  // a level without a source shows nothing and draws nothing
  const before = m.stats.composites;
  m.update({}, pos, 0, 10);
  expect(m.stats.composites === before, 'drew a map for a level with no source');
});

test('large map labels: one per district area, and none overlapping', () => {
  const ls = nycMinimapSource.labels!(-600, -500, 900, 250).filter((l) => l.kind === 'district');
  const names = ls.map((l) => l.text);
  // one label per area: the same name twice only for two separate areas, far apart
  for (let i = 0; i < ls.length; i++) for (let j = i + 1; j < ls.length; j++)
    if (ls[i].text === ls[j].text) expect(Math.hypot(ls[i].x - ls[j].x, ls[i].z - ls[j].z) > 2 * SZ, `${ls[i].text} labelled twice ${fmt(Math.hypot(ls[i].x - ls[j].x, ls[i].z - ls[j].z))} m apart`);
  expect(names.length >= 8, `only ${names.length} district labels`);
  const log: string[] = [];
  const m = new Minimap();
  m.headless = surface(960, 540, log);
  const level = {};
  registerMinimapSource((l) => (l === level ? nycMinimapSource : null));
  m.update(level, { x: 100, z: -150 }, 0, 0);
  m.cycle();
  log.length = 0;
  m.update(level, { x: 100, z: -150 }, 0, 0.1);
  // replay the drawn text: boxes from the same width rule the placer uses; halo strokes are skipped
  let size = 12;
  const boxes: { t: string; x0: number; x1: number; y0: number; y1: number }[] = [];
  for (const e of log) {
    const f = /^font=\d+ (\d+)px/.exec(e);
    if (f) size = Number(f[1]);
    const t = /^fillText\((.*),(-?[\d.]+),(-?[\d.]+)\)$/.exec(e);
    if (!t || t[1].startsWith('M: close') || size < 10.5) continue;
    const w = t[1].length * size * 0.56, x = Number(t[2]), y = Number(t[3]);
    boxes.push({ t: t[1], x0: x - w / 2, x1: x + w / 2, y0: y - size * 0.6, y1: y + size * 0.6 });
  }
  const bad: string[] = [];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0) bad.push(`${a.t} / ${b.t}`);
  }
  expect(boxes.length >= 5, `only ${boxes.length} labels drawn`);
  none(bad, 'overlapping labels');
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
