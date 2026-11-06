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
      if (k === 'floor') units.push(platform({ st, r }, m, true, barrier));
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
  // motor halls sometimes turn the cars to the visitor, alternately left and right (Petersen)
  const turn = st.arch === 'motor' && r.chance(0.6) ? r.range(0.25, 0.45) : 0;
  buckets.floor.forEach((m, i) => units.push(platform({ st, r }, m, false, barrier, turn * (i % 2 ? 1 : -1))));
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
    const row = rows.find((rw) => rw.reduce((s, x) => s + x.w + gapX, 0) + u.w <= Wf && Math.max(...rw.map((x) => x.d)) < u.d * 2.2);
    if (row) row.push(u);
    else rows.push([u]);
  }
  // lowest rows nearest the entrance, so you see over them; the hero stands in the middle
  rows.sort((a, b) => Math.max(...a.map((u) => u.h)) - Math.max(...b.map((u) => u.h)));
  for (const rw of rows) r.shuffle(rw);
  if (heroU) rows.splice(rows.length >= 2 ? Math.floor(rows.length / 2) : rows.length, 0, [heroU]);

  const hangLanes = hangU.length >= 7 ? 3 : hangU.length >= 3 ? 2 : 1;
  let W = Math.max(Wf + 2 * inset, intimate ? 6 : 8, hangLanes * (hangS + 1.5));
  const entry = Math.max(3.6, wallDepth + 2);
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

  // doors and walls: grow the room until every wall display fits
  const big = H >= 7 || W >= 20;
  let doors: Door[] = [];
  let wall: Placed[] | null = null;
  const order = r.shuffle<Wall>(['W', 'E', 'N']).concat(['S']);
  for (let it = 0; it < 40; it++) {
    doors = [{ wall: 'S', at: 0, w: big ? 3.4 : intimate ? 2.0 : 2.4, h: big ? 4.4 : intimate ? 2.7 : 3.2 }, ...exitDoors(W, D, exits, big, r.fork(it), intimate)];
    wall = allocateWalls(wallU, W, D, doors, wallDepth + 0.3, order);
    if (wall) break;
    D += 2;
    if (it % 3 === 2) W += 1.5;
  }
  wall ??= [];
  H = Math.max(H, Math.max(...doors.map((d) => d.h)) + (intimate ? 1.0 : 2.2));
  let Hw = H;
  if (ceiling === 'vault') {
    Hw = H - 0.3 * W;
    if (Hw < 5.5) {
      Hw = 5.5;
      H = Hw + 0.3 * W;
    }
  }

  // place rows, sharing out any extra depth as wider aisles
  const extra = Math.max(0, D - minD) / (rows.length + 1);
  const floor: Placed[] = [];
  const rowsZ: number[] = [];
  let z = -entry - extra;
  rows.forEach((rw, i) => {
    const d = rowD[i];
    const isHero = rw.length === 1 && rw[0].hero;
    if (isHero) z -= 1;
    const zc = z - d / 2;
    rowsZ.push(zc);
    const tw = rw.reduce((s, u) => s + u.w, 0);
    const free = W - 2 * inset - tw;
    const gap = rw.length > 1 ? Math.min(free / (rw.length - 1), st.outdoor ? 10 : 4) : 0;
    let x = -(tw + gap * (rw.length - 1)) / 2;
    for (const u of rw) {
      floor.push({ u, f: new Frame(x + u.w / 2, zc + (d - u.d) / 2 * 0, 0) });
      x += u.w + gap;
    }
    z -= d + aisle + extra + (isHero ? 1 : 0);
  });

  // benches in the widest gaps between rows, off the room's centre line
  if (!st.outdoor && floorU.length >= 4) {
    const gaps: { z: number; g: number }[] = [];
    for (let i = 0; i + 1 < rowsZ.length; i++) {
      const top = rowsZ[i] - rowD[i] / 2, bot = rowsZ[i + 1] + rowD[i + 1] / 2;
      gaps.push({ z: (top + bot) / 2, g: top - bot });
    }
    gaps.sort((x, y) => y.g - x.g);
    gaps.slice(0, floorU.length >= 10 ? 2 : 1).forEach((gp, i) => {
      if (gp.g < 3.2) return;
      const b = bench();
      floor.push({ u: b, f: new Frame((i % 2 ? 1 : -1) * Math.min(W / 4, 4), gp.z, 0) });
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
