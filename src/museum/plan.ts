import * as THREE from 'three';
import type { Rng } from '../rng';
import { Frame } from './base';
import { along, bench, cluster, drawers, periodRoom, hang, mount, platform, plinth, riser, tableCase, typeKey, vitrine, wallCase, type Unit } from './displays';
import type { Measured } from './sizes';
import type { Ceiling, Floor, Style } from './style';

/**
 * Size-driven room planning. Every object is shown at its real size, so the display is chosen
 * from its measured dimensions and the room is then sized to fit what it holds.
 */

export type Kind = 'hang' | 'floor' | 'medium' | 'flat' | 'mount' | 'small' | 'tiny';

export function classify(m: Measured, st: Style, r: Rng): Kind {
  const { x, y, z } = m.real;
  const L = Math.max(x, z), thin = Math.min(x, z);
  if (st.hang && L >= 1.5 && L <= 26 && y <= 6 && y < L * 0.7 && /aircraft|spacecraft|air-space/.test(m.entry.family)) return 'hang';
  if (L > 1.9 || y > 2.0) return 'floor';
  if (st.mount && thin <= 0.22 * Math.max(L, y) && thin <= 0.3 && y >= 0.25 && L >= 0.3 && y <= 2.0 && r.chance(0.85)) return 'mount';
  if (y <= 0.25 && L >= 0.45 && L <= 2.3 && y < L * 0.35) return 'flat';
  if (L >= 0.75 || y >= 0.8) return 'medium';
  if (L < 0.14 && y < 0.2) return 'tiny';
  return 'small';
}

/** turn a room's objects into displays */
export function assemble(items: Measured[], st: Style, r: Rng): Unit[] {
  const units: Unit[] = [];
  const barrier = r.pick(st.barrier);
  const buckets: Record<Kind, Measured[]> = { hang: [], floor: [], medium: [], flat: [], mount: [], small: [], tiny: [] };
  items.forEach((m, i) => {
    const k = classify(m, st, r);
    if (i === 0 && k !== 'hang') {
      // the room's hero: its own stage in the middle
      // (motor halls turn the hero to the visitor, Petersen; turning every car costs its rotated footprint)
      if (k === 'floor') units.push(platform({ st, r }, m, true, barrier, st.arch === 'motor' ? r.range(0.25, 0.45) : 0));
      else if (k === 'medium') units.push(plinth(m, false, true));
      else units.push(plinth(m, true, true, along(m).w < 0.6 ? 0.18 : 0));
      return;
    }
    buckets[k].push(m);
  });
  if (st.outdoor && st.arch === 'openair') {
    // outdoors everything stands on the ground
    for (const m of [...buckets.medium]) units.push(platform({ st, r }, m, false, barrier));
    buckets.medium = [];
  }
  for (const m of buckets.hang) units.push(hang(m, r.range(-0.12, 0.12)));
  buckets.floor.forEach((m) => units.push(platform({ st, r }, m, false, barrier)));
  for (const m of buckets.mount) units.push(mount(m));

  // medium things: period rooms, stepped risers, plinth landscapes or single plinths
  let med = r.shuffle([...buckets.medium]);
  if (st.arch === 'period' && med.length >= 3 && r.chance(0.7)) {
    const n = Math.min(med.length, r.int(3, 5));
    units.push(periodRoom(med.slice(0, n), r));
    med = med.slice(n);
  }
  const leftovers: Measured[] = [];
  while (med.length) {
    const mode = st.medium.includes('riser') && med.length >= 3 && r.chance(0.75) ? 'riser' : st.medium.includes('cluster') && med.length >= 2 && r.chance(0.6) ? 'cluster' : 'plinth';
    if (mode === 'riser') {
      const n = Math.min(med.length, r.int(3, 6));
      units.push(riser(med.slice(0, n), barrier === 'glass' ? 'rope' : barrier));
      med = med.slice(n);
    } else if (mode === 'cluster') {
      const n = Math.min(med.length, r.int(2, 3));
      units.push(cluster(med.slice(0, n), r, false));
      med = med.slice(n);
    } else {
      units.push(plinth(med[0], false, false));
      med = med.slice(1);
    }
  }

  // small things: by the room's preferred cases
  const primary = r.pick(st.small.filter((s) => s !== 'table').length ? st.small.filter((s) => s !== 'table') : st.small);
  // long flat things lie in table cases whatever the room
  const table: Measured[] = [...buckets.flat];
  const main: Measured[] = [];
  // the tiniest things in study rooms live in specimen drawers
  let tiny = buckets.tiny;
  if ((st.arch === 'study' || st.arch === 'science') && tiny.length >= 4) {
    while (tiny.length >= 3) {
      const d = drawers(tiny);
      if (!d.unit.items.length) break;
      units.push(d.unit);
      tiny = d.rest;
    }
  }
  for (const m of [...tiny, ...buckets.small]) {
    const flat = m.real.y <= 0.25;
    // table cases for some flat things; the rest fill the room's shelves (dense, like visible storage)
    if (st.small.includes('table') && flat && r.chance(st.small[0] === 'table' ? 0.7 : 0.35)) table.push(m);
    else main.push(m);
  }
  let rest = table;
  while (rest.length) {
    const n = r.int(6, 12);
    const t = tableCase(rest.slice(0, n), r.pick([1.2, 1.8, 2.4]));
    t.rest.push(...rest.slice(n));
    if (!t.unit.items.length) {
      main.push(...t.rest);
      break;
    }
    units.push(t.unit);
    rest = t.rest;
  }
  // like with like: cases are filled type by type (cups with cups, keys with keys)
  rest = [...main].sort((a, b) => typeKey(a).localeCompare(typeKey(b)));
  if (primary === 'hood') {
    while (rest.length) {
      const n = r.chance(0.65) ? Math.min(rest.length, r.int(2, 4)) : 1;
      units.push(n > 1 ? cluster(rest.slice(0, n), r, true) : plinth(rest[0], true, false));
      rest = rest.slice(n);
    }
    rest = [];
  } else if (primary === 'vitrine') {
    while (rest.length) {
      const inner = THREE.MathUtils.clamp(Math.max(...rest.slice(0, 3).map((m) => along(m).w)) + 0.1, 0.5, 0.95);
      const v = vitrine(rest.slice(0, r.int(1, 4)), inner);
      if (!v.unit.items.length) {
        leftovers.push(rest[0]);
        rest = rest.slice(1);
        continue;
      }
      units.push(v.unit);
      rest = [...v.rest, ...rest.slice(v.unit.items.length + v.rest.length)];
    }
  } else {
    const storage = primary === 'storage';
    while (rest.length) {
      const len = storage ? 3.6 : r.pick([1.8, 2.4, 3.0]);
      const w = wallCase(rest, len, storage);
      if (!w.unit.items.length) {
        leftovers.push(...w.rest);
        break;
      }
      units.push(w.unit);
      rest = w.rest;
    }
  }
  for (const m of leftovers) units.push(plinth(m, Math.max(m.real.x, m.real.z) < 0.6, false));
  return units;
}

// ---------------------------------------------------------------- rooms of a theme

/** floor area budget per room (m2 of displays incl. their clearance): halls stay within ~60 x 120 m */
const ROOM_AREA = 4200;

/**
 * Cut a theme's objects into rooms by what fits: at most `maxN` objects, a floor-area budget, and
 * at most two colossal (> 25 m) objects per hall. Unknown sizes count as small things.
 */
export function partitionRooms<T>(items: T[], size: (t: T) => THREE.Vector3 | null, maxN: number): T[][] {
  const rooms: T[][] = [];
  let cur: T[] = [];
  let area = 0, colossal = 0;
  for (const it of items) {
    const v = size(it);
    const L = v ? Math.max(v.x, v.z) : 0.3, S = v ? Math.min(v.x, v.z) : 0.3, y = v ? v.y : 0.3;
    const big = L > 1.9 || y > 2;
    const a = big ? (L + 2.5) * (S + 3.5) : L > 0.75 ? 4 : 1;
    const col = L > 25;
    if (cur.length && (cur.length >= maxN || area + a > ROOM_AREA || (col && colossal >= 2))) {
      rooms.push(cur);
      cur = [];
      area = 0;
      colossal = 0;
    }
    cur.push(it);
    area += a;
    if (col) colossal++;
  }
  if (cur.length || !rooms.length) rooms.push(cur);
  return rooms;
}

// ---------------------------------------------------------------- planning

export type Wall = 'N' | 'S' | 'E' | 'W';
export interface Door {
  wall: Wall;
  at: number;
  w: number;
  h: number;
  /** a lit vestibule behind the doorway instead of a dark passage (the atrium's wing doors) */
  vest?: { depth: number; color: string };
}
export interface Placed {
  u: Unit;
  f: Frame;
  /** hung things: the ceiling height above them */
  ceiling?: number;
}
export interface Plan {
  W: number;
  D: number;
  /** clear height in the middle of the room */
  H: number;
  /** height of the walls (lower than H under a vault) */
  Hw: number;
  floor: Placed[];
  wall: Placed[];
  hang: Placed[];
  doors: Door[];
  ceiling: Ceiling;
  floorKind: Floor;
  wallColor: string;
  rows: number[];
  /** free-standing columns in big halls, and pilasters along the walls */
  columns: { x: number; z: number }[];
  pilasters: { wall: Wall; at: number }[];
}

/** a wall's inner face, and the frame for something standing against it at `s` */
export function wallFrame(wall: Wall, s: number, W: number, D: number) {
  switch (wall) {
    case 'W': return new Frame(-W / 2, s, Math.PI / 2);
    case 'E': return new Frame(W / 2, s, -Math.PI / 2);
    case 'N': return new Frame(s, -D, 0);
    case 'S': return new Frame(s, 0, Math.PI);
  }
}

function wallSpan(wall: Wall, W: number, D: number): [number, number] {
  return wall === 'N' || wall === 'S' ? [-W / 2, W / 2] : [-D, 0];
}

function exitDoors(W: number, D: number, n: number, big: boolean, r: Rng, small = false): Door[] {
  const w = big ? 3.4 : small ? 1.8 : 2.2, h = big ? 4.4 : small ? 2.6 : 3.0;
  const pats: Door[][] = [];
  if (W >= 3 * w + 6) pats.push([-W / 4, 0, W / 4].map((at) => ({ wall: 'N', at, w, h })));
  if (D >= 10) {
    pats.push([{ wall: 'N', at: 0, w, h }, { wall: 'W', at: -D * 0.72, w, h }, { wall: 'E', at: -D * 0.72, w, h }]);
    pats.push([{ wall: 'N', at: 0, w, h }, { wall: 'W', at: -D * 0.45, w, h }, { wall: 'E', at: -D * 0.78, w, h }]);
    pats.push([{ wall: 'N', at: W / 2 > 6 ? -W / 4 : 0, w, h }, { wall: 'E', at: -D * 0.5, w, h }, { wall: 'E', at: -D * 0.85, w, h }]);
  }
  if (!pats.length) pats.push([{ wall: 'N', at: 0, w, h }, { wall: 'W', at: -D * 0.7, w, h }, { wall: 'E', at: -D * 0.7, w, h }]);
  return r.pick(pats).slice(0, n) as Door[];
}

function freeIntervals(wall: Wall, W: number, D: number, doors: Door[], corner: number) {
  const [a0, a1] = wallSpan(wall, W, D);
  const cuts: [number, number][] = doors.filter((d) => d.wall === wall).map((d) => [d.at - d.w / 2 - 0.7, d.at + d.w / 2 + 0.7]);
  if (wall === 'S') cuts.push([-4.8, 4.8]); // entrance, intro panel
  cuts.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let cur = a0 + corner;
  for (const [c0, c1] of cuts) {
    if (c0 > cur) out.push([cur, Math.min(c0, a1 - corner)]);
    cur = Math.max(cur, c1);
  }
  if (a1 - corner > cur) out.push([cur, a1 - corner]);
  return out.filter(([x0, x1]) => x1 - x0 > 0.5);
}

/** greedy: fill intervals with wall units, spreading each run evenly */
function allocateWalls(units: Unit[], W: number, D: number, doors: Door[], corner: number, order: Wall[]): Placed[] | null {
  const placed: Placed[] = [];
  let i = 0;
  for (const wall of order) {
    for (const [s0, s1] of freeIntervals(wall, W, D, doors, corner)) {
      const run: Unit[] = [];
      let used = 0;
      while (i < units.length && used + units[i].w + (run.length ? 0.5 : 0) <= s1 - s0) {
        used += units[i].w + (run.length ? 0.5 : 0);
        run.push(units[i++]);
      }
      if (!run.length) continue;
      const free = s1 - s0 - run.reduce((s, u) => s + u.w, 0);
      const gap = Math.min(free / (run.length + 1), 2.5);
      let s = s0 + (free - gap * (run.length - 1)) / 2;
      for (const u of run) {
        const c = s + u.w / 2;
        // walls run W/E along z from -D to 0; place so the unit faces into the room
        placed.push({ u, f: wallFrame(wall, c, W, D) });
        s += u.w + gap;
      }
    }
  }
  return i >= units.length ? placed : null;
}

export function planRoom(units: Unit[], st: Style, r: Rng, exits: number): Plan {
  const floorU = units.filter((u) => u.place === 'floor');
  const wallU = r.shuffle(units.filter((u) => u.place === 'wall'));
  // keep like with like on the walls
  wallU.sort((a, b) => a.type.localeCompare(b.type));
  const hangU = units.filter((u) => u.place === 'hang');
  const heroU = floorU.find((u) => u.hero);
  const others = floorU.filter((u) => !u.hero);

  // rooms of small things only are small and intimate (cabinet rooms): lower, closer, smaller doors
  const SMALL = ['table', 'vitrine', 'hood', 'cluster', 'drawers', 'wallcase', 'storage', 'mount', 'bench'];
  const intimate = !st.outdoor && !hangU.length && units.every((u) => SMALL.includes(u.type) || (u.hero && u.type === 'hood'));
  const ceiling = intimate && r.chance(0.6) ? 'flat' : r.pick(st.ceilings);
  const floorKind = r.pick(st.floors);
  const wallColor = r.pick(st.walls);
  const wallDepth = wallU.length ? Math.max(...wallU.map((u) => u.d)) : 0;
  const aisle = st.outdoor ? 3 : intimate ? 1.4 : 1.7;
  const gapX = st.outdoor ? 4 : 1.2;
  const inset = wallU.length ? wallDepth + 1.5 : st.arch === 'openair' ? 5 : 1.3;

  // floor rows
  const area = others.reduce((s, u) => s + (u.w + gapX) * (u.d + aisle), 0) + (heroU ? (heroU.w + 3) * (heroU.d + 3) : 0);
  // colossal things (ships, rockets) go in square halls, several to a row (Udvar-Hazy is 300 x 75 m)
  const colossal = Math.max(0, ...floorU.map((u) => u.w)) > 25;
  const aspect = colossal ? r.range(0.7, 1.1) : r.range(st.aspect[0], st.aspect[1]);
  const maxW = Math.max(0, ...floorU.map((u) => u.w));
  const hangS = Math.max(0, ...hangU.map((u) => u.w));
  // the floor stays within ~60 m wide unless one object is wider than that
  let Wf = Math.max(maxW, Math.min(Math.sqrt(area / aspect), 60 - 2 * inset), hangS + 2 - 2 * inset, 6.5);
  // narrow galleries for wall-case rooms
  if (!floorU.length) Wf = Math.max(4.5, Wf);
  const sorted = [...others].sort((a, b) => b.d - a.d);
  const rows: Unit[][] = [];
  for (const u of sorted) {
    const row = rows.find((rw) => rw.reduce((s, x) => s + x.w + gapX, 0) + u.w <= Wf && Math.max(...rw.map((x) => x.d)) < u.d * 3);
    if (row) row.push(u);
    else rows.push([u]);
  }
  // lowest rows nearest the entrance, so you see over them; the hero stands in the middle
  rows.sort((a, b) => Math.max(...a.map((u) => u.h)) - Math.max(...b.map((u) => u.h)));
  for (const rw of rows) r.shuffle(rw);
  if (heroU) rows.splice(rows.length >= 2 ? Math.floor(rows.length / 2) : rows.length, 0, [heroU]);
  // the rows hold fewer than the area guess assumed (depths must match within a row): the floor is
  // only as wide as the widest row plus a doorway's corridor (2.6 m), else small things stand lost in
  // a hall (the placement below widens it again if anything does not fit)
  const rowW = Math.max(0, ...rows.map((rw) => rw.reduce((s, u) => s + u.w + 0.6, 0)));
  if (rows.length) Wf = Math.min(Wf, Math.max(maxW, rowW + 2.6 + 0.6, hangS + 2 - 2 * inset, floorU.length ? 6.5 : 4.5));

  const hangLanes = hangU.length >= 7 ? 3 : hangU.length >= 3 ? 2 : 1;
  let W = Math.max(Wf + 2 * inset, intimate ? 6 : 8, hangLanes * (hangS + 1.5));
  // the zone inside the entrance is deep enough for the side doorways to open there (a door's width
  // plus its corridor): otherwise every row gap had to grow until one fitted a side door
  const entry = Math.max(3.6, wallDepth + 2, !intimate && exits >= 2 ? 3.4 + 1.8 : 0);
  const rowD = rows.map((rw) => Math.max(...rw.map((u) => u.d)));
  const minD = entry + rowD.reduce((s, d) => s + d, 0) + aisle * Math.max(0, rows.length - 1) + (heroU ? 2 : 0) + inset;
  const laneLen = Math.max(0, ...Array.from({ length: hangLanes }, (_, li) => hangU.filter((_, i) => i % hangLanes === li).reduce((s, u) => s + u.d + 2, 2)));
  let D = Math.max(minD, intimate ? 7.5 : 10, laneLen);
  if (st.outdoor && st.arch === 'openair') {
    W = Math.max(W, 24);
    D = Math.max(D, 24);
  }

  // height
  let H = intimate ? r.range(3.5, 4.3) : r.range(st.height[0], st.height[1]);
  const floorTop = Math.max(0, ...floorU.map((u) => u.h));
  const wallTop = Math.max(0, ...wallU.map((u) => u.h));
  const hangH = Math.max(0, ...hangU.map((u) => u.h));
  H = Math.max(H, floorTop + 1.8, wallTop + 1.0);
  if (hangU.length) H = Math.max(H, Math.max(floorTop, 2.6) + 1.2 + hangH + 1.2);

  // Doors, walls and rows together. Every onward doorway keeps a clear sight-and-walk corridor
  // (CLEAR m wide) from the room's middle: north doors a band through every row, side doors an
  // aisle between rows wide enough for them. The room grows until all of that and the wall
  // displays fit.
  const CLEAR = 2.6;
  const big = H >= 7 || W >= 20;
  const entrance: Door = { wall: 'S', at: 0, w: big ? 3.4 : intimate ? 2.0 : 2.4, h: big ? 4.4 : intimate ? 2.7 : 3.2 };
  let doors: Door[] = [entrance];
  let wall: Placed[] | null = null;
  let floor: Placed[] = [];
  let rowsZ: number[] = [];
  const order = r.shuffle<Wall>(['W', 'E', 'N']).concat(['S']);

  /** rows at depth D, width W, packed around the north doors' corridors; null if a row cannot fit */
  const placeRows = (W: number, D: number, north: Door[]) => {
    const extra = Math.max(0, D - minD) / (rows.length + 1);
    const out: Placed[] = [];
    const zs: number[] = [];
    const bands = north.map((d) => [d.at - Math.max(CLEAR, d.w + 0.4) / 2, d.at + Math.max(CLEAR, d.w + 0.4) / 2] as [number, number]).sort((p, q) => p[0] - q[0]);
    // free segments across the floor
    const segs: [number, number][] = [];
    let cur = -W / 2 + inset;
    for (const [b0, b1] of bands) {
      if (b0 > cur) segs.push([cur, Math.min(b0, W / 2 - inset)]);
      cur = Math.max(cur, b1);
    }
    if (W / 2 - inset > cur) segs.push([cur, W / 2 - inset]);
    let z = -entry - extra;
    for (let i = 0; i < rows.length; i++) {
      const rw = rows[i];
      const d = rowD[i];
      const isHero = rw.length === 1 && rw[0].hero;
      if (isHero) z -= 1;
      const zc = z - d / 2;
      zs.push(zc);
      // fill the segments left to right (the widest first for a lone hero)
      const order2 = isHero ? [...segs].sort((p, q) => q[1] - q[0] - (p[1] - p[0])) : segs;
      const fill: Unit[][] = order2.map(() => []);
      let si = 0;
      for (const u of rw) {
        while (si < order2.length && fill[si].reduce((s2, x) => s2 + x.w + 0.6, 0) + u.w > order2[si][1] - order2[si][0]) si++;
        if (si >= order2.length) return null;
        fill[si].push(u);
      }
      order2.forEach(([s0, s1], k) => {
        const us = fill[k];
        if (!us.length) return;
        const tw = us.reduce((s2, u) => s2 + u.w, 0);
        const gap = Math.min((s1 - s0 - tw) / (us.length + 1), st.outdoor ? 10 : 4);
        let x = (s0 + s1) / 2 - (tw + gap * (us.length - 1)) / 2;
        for (const u of us) {
          out.push({ u, f: new Frame(x + u.w / 2, zc, 0) });
          x += u.w + gap;
        }
      });
      z -= d + aisle + extra + (isHero ? 1 : 0);
    }
    return { floor: out, rowsZ: zs };
  };

  for (let it = 0; it < 60; it++) {
    let proposed = exitDoors(W, D, exits, big, r.fork(it < 6 ? 0 : it), intimate);
    let placed = placeRows(W, D, proposed.filter((d) => d.wall === 'N'));
    if (!placed && proposed.some((d) => d.wall === 'N')) {
      // a wide display does not fit beside the north doorway's corridor: move the doorway towards a
      // side wall (one wide stretch of floor) before making the room bigger
      for (const side of [1, -1]) {
        const moved = proposed.map((d) => (d.wall === 'N' ? { ...d, at: side * (W / 2 - 1.2 - d.w / 2) } : d));
        if (moved.filter((d) => d.wall === 'N').length > 1) break;
        placed = placeRows(W, D, moved.filter((d) => d.wall === 'N'));
        if (placed) {
          proposed = moved;
          break;
        }
      }
    }
    if (!placed) {
      W += 2;
      continue;
    }
    // side doors move into the nearest open band between rows (or before the first / after the last)
    const gaps: [number, number][] = [];
    let top = 0;
    placed.rowsZ.forEach((zc, i) => {
      gaps.push([zc + rowD[i] / 2, top]);
      top = zc - rowD[i] / 2;
    });
    gaps.push([-D, top]);
    let ok = true;
    const used: { wall: Wall; at: number }[] = [];
    const final = proposed.map((d) => {
      if (d.wall === 'N') return d;
      const need = Math.max(CLEAR, d.w + 0.4);
      let best: number | null = null;
      for (const [g0, g1] of gaps) {
        const lo = Math.max(g0 + need / 2, -D + 1 + d.w / 2), hi = Math.min(g1 - need / 2, -1.5 - d.w / 2);
        if (lo > hi) continue;
        const at = Math.min(hi, Math.max(lo, d.at));
        if (used.some((u) => u.wall === d.wall && Math.abs(u.at - at) < d.w + 1)) continue;
        if (best === null || Math.abs(at - d.at) < Math.abs(best - d.at)) best = at;
      }
      if (best === null) {
        ok = false;
        return d;
      }
      used.push({ wall: d.wall, at: best });
      return { ...d, at: best };
    });
    if (!ok) {
      D += 1; // the room's slack spreads over every gap between rows: grow in small steps
      continue;
    }
    doors = [entrance, ...final];
    wall = allocateWalls(wallU, W, D, doors, wallDepth + 0.3, order);
    if (!wall) {
      D += 2;
      if (it % 3 === 2) W += 1.5;
      continue;
    }
    floor = placed.floor;
    rowsZ = placed.rowsZ;
    break;
  }
  wall ??= [];
  if (!floor.length && rows.length) {
    // could not satisfy every corridor: fall back to rows without them
    const placed = placeRows(W, D, [])!;
    floor = placed.floor;
    rowsZ = placed.rowsZ;
    if (doors.length < 1 + exits) doors = [entrance, ...exitDoors(W, D, exits, big, r.fork(99), intimate)];
  }
  H = Math.max(H, Math.max(...doors.map((d) => d.h)) + (intimate ? 1.0 : 2.2));
  let Hw = H;
  if (ceiling === 'vault') {
    Hw = H - 0.3 * W;
    if (Hw < 5.5) {
      Hw = 5.5;
      H = Hw + 0.3 * W;
    }
  }

  // benches in the widest gaps between rows, off the room's centre line, clear of the doorway corridors
  if (!st.outdoor && floorU.length >= 4) {
    const gaps: { z: number; g: number }[] = [];
    for (let i = 0; i + 1 < rowsZ.length; i++) {
      const top = rowsZ[i] - rowD[i] / 2, bot = rowsZ[i + 1] + rowD[i + 1] / 2;
      const zc = (top + bot) / 2;
      if (doors.some((d) => (d.wall === 'E' || d.wall === 'W') && Math.abs(d.at - zc) < 2.5)) continue;
      gaps.push({ z: zc, g: top - bot });
    }
    gaps.sort((x, y) => y.g - x.g);
    const north = doors.filter((d) => d.wall === 'N');
    gaps.slice(0, floorU.length >= 10 ? 2 : 1).forEach((gp, i) => {
      if (gp.g < 3.2) return;
      let x = (i % 2 ? 1 : -1) * Math.min(W / 4, 4);
      for (const d of north) if (Math.abs(x - d.at) < CLEAR / 2 + 1.2) x = d.at + Math.sign(x - d.at || 1) * (CLEAR / 2 + 1.3);
      if (Math.abs(x) > W / 2 - 1.5) return;
      floor.push({ u: bench(), f: new Frame(x, gp.z, 0) });
    });
  }

  // hung things in lanes along the hall's length, alternating heights
  const hangP: Placed[] = [];
  if (hangU.length) {
    const lanes: Unit[][] = Array.from({ length: hangLanes }, () => []);
    hangU.forEach((u, i) => lanes[i % hangLanes].push(u));
    lanes.forEach((lane, li) => {
      const xc = hangLanes === 1 ? 0 : -W / 2 + (W * (li + 0.5)) / hangLanes;
      const total = lane.reduce((s, u) => s + u.d, 0);
      const sp = (D - total) / (lane.length + 1);
      let hz = -sp;
      lane.forEach((u, i) => {
        const zc = hz - u.d / 2;
        const ceil = ceiling === 'vault' ? Hw + Math.sqrt(Math.max(0, 1 - (xc / (W / 2)) ** 2)) * (H - Hw) : H;
        const low = (i + li) % 2;
        const y = Math.max(Math.max(floorTop, 2.6) + 1.0, ceil - 1.0 - u.h - low * Math.min(2.5, (ceil - floorTop - u.h - 3) * 0.5));
        hangP.push({ u, f: new Frame(xc, zc, 0, y), ceiling: ceil - 0.2 });
        hz -= u.d + sp;
      });
    });
  }
  // structure: pilasters between the wall displays, a column grid in the aisles of big halls
  const pilasters: { wall: Wall; at: number }[] = [];
  const columns: { x: number; z: number }[] = [];
  const structural = !st.outdoor && ceiling !== 'vault' && ceiling !== 'glass' && st.arch !== 'whitecube' && st.arch !== 'science';
  if (structural && (W >= 14 || D >= 20)) {
    const busy = (wall: Wall, at: number) =>
      doors.some((d) => d.wall === wall && Math.abs(d.at - at) < d.w / 2 + 0.6) ||
      wall_.some((q) => q.wall === wall && Math.abs(q.at - at) < q.u.w / 2 + 0.4) ||
      (wall === 'S' && Math.abs(at) < 5);
    const wall_ = (wall ?? []).map((q) => ({ u: q.u, wall: (Math.abs(q.f.rot - Math.PI / 2) < 0.01 ? 'W' : Math.abs(q.f.rot + Math.PI / 2) < 0.01 ? 'E' : Math.abs(q.f.rot) < 0.01 ? 'N' : 'S') as Wall, at: Math.abs(q.f.rot) < 0.01 || Math.abs(Math.abs(q.f.rot) - Math.PI) < 0.01 ? q.f.x : q.f.z }));
    const sp = st.arch === 'period' ? 4.5 : 6;
    for (const wl of ['W', 'E', 'N'] as Wall[]) {
      const [a0, a1] = wl === 'N' ? [-W / 2, W / 2] : [-D, 0];
      const n = Math.floor((a1 - a0) / sp);
      for (let i = 1; i < n; i++) {
        const at = a0 + ((a1 - a0) * i) / n;
        if (!busy(wl, at)) pilasters.push({ wall: wl, at });
      }
    }
  }
  if (structural && W >= 26 && ceiling !== 'lantern' && !hangU.length) {
    const sp = 9;
    const nx = Math.floor(W / sp);
    for (let i = 1; i < nx; i++) {
      const x = -W / 2 + (W * i) / nx;
      if (Math.abs(x) < 2.5) continue;
      for (let k = 0; k + 1 < rowsZ.length; k++) {
        const z = (rowsZ[k] - rowD[k] / 2 + rowsZ[k + 1] + rowD[k + 1] / 2) / 2;
        const clear = floor.every((q) => Math.abs(q.f.x - x) > q.u.w / 2 + 0.9 || Math.abs(q.f.z - z) > q.u.d / 2 + 0.9);
        if (clear && z < -3) columns.push({ x, z });
      }
    }
  }
  return { W, D, H, Hw, floor, wall, hang: hangP, doors, ceiling, floorKind, wallColor, rows: rowsZ, columns, pilasters };
}
