import { AX, SZ, AVE, ST, SW } from './common';
import { Rng, hashN } from '../rng';

/**
 * The district map: which neighbourhood each block of the NYC grid belongs to
 * (docs/research/districts.md). Districts are a few blocks each, packed much closer than in the
 * real city so every kind of place is a short walk from the spawn point (5 Av & W 34 St):
 *
 *   - a Central Park–style park to the north (lawns, paths, playground, boat pond, rock outcrops)
 *   - Times Square and a 48th St music row a block or two west, the 47th St / garment strip south
 *   - Eleventh Avenue's auto row (showrooms, lots of real-scale cars) and the Hudson piers further west
 *   - a LaGuardia-style airport apron and the East River to the east, brownstones in between
 *   - the Bowery kitchen & lighting strip, Canal St, a greenmarket and the rail yards downtown
 *
 * This module is pure data and queries (no three.js), so traffic and pedestrians can ask it where
 * roads end and where you can walk. Chunk builders live in district-*.ts.
 *
 * Grid: chunk (cx, cz) is the block between avenues; +x is west (towards the Hudson), +z is south
 * (downtown). Chunk (0,0) is the spawn block.
 */

export type DKind =
  | 'midtown' | 'timesq' | 'music' | 'garment' | 'bowery' | 'canal' | 'market' | 'brownstone'
  | 'industrial' | 'construction' | 'museum' | 'autorow' | 'park' | 'airport' | 'pier' | 'river';

/** chunks of the same open group have no road between them */
export type OpenGroup = 'park' | 'airport' | 'water';

export type BType = 'brownstone' | 'tenement' | 'prewar' | 'midrise' | 'castiron';

export interface District {
  kind: DKind;
  name: string;
  /** open space: no buildings, roads between neighbours of the same group are removed */
  open?: OpenGroup;
  /** 0..1 how tall the avenue frontage is (old nyc.ts noise: > 0.62 towers) */
  tower: number;
  /** brownstone-row character: crook lamps, more trees */
  village: boolean;
  /** building types of the mid-block rows and the avenue frontage (weights) */
  rows: Partial<Record<BType, number>>;
  ave: Partial<Record<BType, number>>;
  /** floors multiplier (industrial lofts are low) */
  floors?: number;
  /** shop types (src/nyc/buildings-shop.ts SHOPS) with weights */
  shops: Record<string, number>;
  /** chance multiplier for a ground-floor store */
  stores: number;
  /** showcase pools for sidewalk displays outside the shops (public/districts/pools.json kinds) */
  displays: string[];
  /** street tree density multiplier */
  trees: number;
  /** water lies on this side of a pier chunk: +1 = west (+x), -1 = east (-x) */
  waterSide?: 1 | -1;
}

const ALL_SHOPS = { deli: 3, pharmacy: 2, electronics: 1, toys: 1, music: 0.5, kitchen: 0.5, lighting: 0.5, sports: 1, furniture: 0.7, antiques: 0.7, stationery: 1, garden: 0.5, models: 0.4, hardware: 0.7, machines: 0.2 };

const P: Record<DKind, Omit<District, 'kind'>> = {
  midtown: { name: 'Midtown', tower: 0.8, village: false, rows: { midrise: 3, prewar: 3, castiron: 1, tenement: 1 }, ave: { prewar: 3, midrise: 1 }, shops: ALL_SHOPS, stores: 1, displays: [], trees: 0.6 },
  timesq: { name: 'Times Square', tower: 0.95, village: false, rows: { midrise: 3, prewar: 2, castiron: 1 }, ave: { prewar: 2, midrise: 2 }, shops: { toys: 4, electronics: 4, sports: 2, deli: 2, models: 2, music: 1, pharmacy: 1 }, stores: 1.3, displays: ['toy', 'electronics'], trees: 0 },
  music: { name: 'Music Row', tower: 0.5, village: false, rows: { tenement: 3, castiron: 2, midrise: 1 }, ave: { prewar: 2, tenement: 1 }, shops: { music: 8, electronics: 2, deli: 1 }, stores: 1.3, displays: ['music'], trees: 0.3 },
  garment: { name: 'Garment District', tower: 0.6, village: false, rows: { castiron: 3, prewar: 2, midrise: 2 }, ave: { prewar: 3, midrise: 1 }, shops: { sports: 5, stationery: 2, antiques: 2, models: 2, deli: 1, toys: 1 }, stores: 1.2, displays: ['sport', 'stationery'], trees: 0.3 },
  bowery: { name: 'The Bowery', tower: 0.3, village: false, rows: { tenement: 4, castiron: 2 }, ave: { tenement: 2, castiron: 1 }, shops: { kitchen: 5, lighting: 5, furniture: 2, deli: 1 }, stores: 1.4, displays: ['kitchen', 'lighting', 'appliance', 'furniture'], trees: 0.3 },
  canal: { name: 'Canal Street', tower: 0.3, village: false, rows: { tenement: 4, castiron: 3 }, ave: { tenement: 2, castiron: 2 }, shops: { electronics: 5, hardware: 4, toys: 2, antiques: 2, deli: 1 }, stores: 1.4, displays: ['electronics', 'tool', 'hardware', 'toy'], trees: 0.2 },
  market: { name: 'Greenmarket', tower: 0.35, village: false, rows: { tenement: 4, castiron: 1 }, ave: { tenement: 2, prewar: 1 }, shops: { deli: 4, garden: 3, kitchen: 2, pharmacy: 1 }, stores: 1.4, displays: ['produce', 'packaged'], trees: 0.6 },
  brownstone: { name: 'Brownstone Row', tower: 0.2, village: true, rows: { brownstone: 6, tenement: 1 }, ave: { tenement: 2, prewar: 1 }, shops: { deli: 2, antiques: 3, garden: 2, stationery: 2, pharmacy: 1, furniture: 2 }, stores: 0.6, displays: ['furniture', 'stationery', 'appliance', 'bath'], trees: 1.5 },
  industrial: { name: 'Meatpacking & Rail Yards', tower: 0.25, village: false, rows: { midrise: 3, castiron: 1, tenement: 1 }, ave: { midrise: 2 }, floors: 0.55, shops: { machines: 5, hardware: 4, deli: 1 }, stores: 0.9, displays: ['freight', 'machine'], trees: 0.2 },
  construction: { name: 'Hudson Yards', tower: 0.7, village: false, rows: { midrise: 2, tenement: 1 }, ave: { midrise: 1 }, shops: { hardware: 5, machines: 2, deli: 1 }, stores: 0.8, displays: ['tool'], trees: 0.2 },
  museum: { name: 'Museum Mile', tower: 0.5, village: false, rows: { prewar: 3, brownstone: 1 }, ave: { prewar: 3 }, shops: { antiques: 4, stationery: 3, models: 2 }, stores: 0.5, displays: [], trees: 1.2 },
  autorow: { name: 'Auto Row', tower: 0.3, village: false, rows: { midrise: 2, tenement: 1 }, ave: { midrise: 1 }, floors: 0.7, shops: { models: 3, hardware: 2, machines: 2, deli: 1 }, stores: 0.8, displays: [], trees: 0.2 },
  park: { name: 'Central Park', open: 'park', tower: 0, village: true, rows: {}, ave: {}, shops: {}, stores: 0, displays: [], trees: 0 },
  airport: { name: 'LaGuardia', open: 'airport', tower: 0, village: false, rows: {}, ave: {}, shops: {}, stores: 0, displays: [], trees: 0 },
  pier: { name: 'Hudson River Park', open: 'water', tower: 0, village: false, rows: {}, ave: {}, shops: {}, stores: 0, displays: [], trees: 0 },
  river: { name: 'Hudson River', open: 'water', tower: 0, village: false, rows: {}, ave: {}, shops: {}, stores: 0, displays: [], trees: 0 },
};

/**
 * The hand-made heart of the map. Columns cx = -4..7, rows cz = -7..3.
 *   M midtown  T times sq  S music row  D garment  B bowery  C canal  K market  H brownstone
 *   I industrial  X construction  U museum mile  A auto row  P park  F airport  R pier  W river
 */
const MAP_X0 = -4, MAP_Z0 = -7;
const MAP = [
  'WHUPPPPSAARW',
  'WHUPPPPSAARW',
  'WHUPPPPSAARW',
  'FHUPPPPSAARW',
  'FHHMMMTTAARW',
  'FFHMMMTTXARW',
  'FFHMMMMDXIRW',
  'FFHMMMMDXIRW',
  'WFKBMMDDIIRW',
  'WWKKCCBBIIRW',
  'WWKKCCBBIIRW',
];
const CODE: Record<string, DKind> = { M: 'midtown', T: 'timesq', S: 'music', D: 'garment', B: 'bowery', C: 'canal', K: 'market', H: 'brownstone', I: 'industrial', X: 'construction', U: 'museum', A: 'autorow', P: 'park', F: 'airport', R: 'pier', W: 'river' };
/** the rest of the island: 3x3-block neighbourhoods drawn from this mix */
const FAR: [DKind, number][] = [['midtown', 3], ['brownstone', 3], ['industrial', 1.5], ['market', 1], ['canal', 1], ['bowery', 1], ['garment', 1], ['music', 0.5], ['construction', 1], ['autorow', 0.5], ['museum', 0.5], ['park', 1.2]];

const cache = new Map<number, District>();

function kindAt(cx: number, cz: number): DKind {
  // the island: the Hudson to the west, the East River beyond the airport to the east
  if (cx >= MAP_X0 + 11) return 'river';
  if (cx === MAP_X0 + 10) return 'pier';
  if (cx <= MAP_X0 - 1) return 'river';
  const row = MAP[cz - MAP_Z0];
  if (row) return CODE[row[cx - MAP_X0]];
  if (cx === MAP_X0) return 'river';
  // beyond the hand-made map: neighbourhoods of 3x3 blocks
  const gx = Math.floor((cx + 30) / 3), gz = Math.floor((cz + 30) / 3);
  const r = new Rng(hashN(gx, gz, 4242));
  let t = r.next() * FAR.reduce((s, [, w]) => s + w, 0);
  let k: DKind = 'midtown';
  for (const [kind, w] of FAR) if ((t -= w) < 0) { k = kind; break; }
  // parks out here are a single square in the middle of their neighbourhood
  if (k === 'park' && !((cx + 30) % 3 === 1 && (cz + 30) % 3 === 1)) k = 'brownstone';
  return k;
}

export function districtAt(cx: number, cz: number): District {
  const key = (cx + 4096) * 8192 + (cz + 4096);
  let d = cache.get(key);
  if (!d) {
    const kind = kindAt(cx, cz);
    d = { kind, ...P[kind] };
    if (kind === 'pier') d.waterSide = cx > 0 ? 1 : -1;
    cache.set(key, d);
  }
  return d;
}

/** the district at a world position */
export function districtAtPos(x: number, z: number) {
  return districtAt(Math.round(x / AX), Math.round(z / SZ));
}

function merged(a: District, b: District) {
  if (!a.open || !b.open) return false;
  return a.open === b.open || a.open === 'water' || b.open === 'water';
}

export type Edge = '+x' | '-x' | '+z' | '-z';
/** is there a road along this edge of chunk (cx, cz)? */
export function roadOpen(cx: number, cz: number, e: Edge) {
  const n = e === '+x' ? districtAt(cx + 1, cz) : e === '-x' ? districtAt(cx - 1, cz) : e === '+z' ? districtAt(cx, cz + 1) : districtAt(cx, cz - 1);
  return !merged(districtAt(cx, cz), n);
}

/**
 * For traffic: is the road at this point of a lane (axis 'z' = avenue at x = line, 'x' = street
 * at z = line) there? Roads stop where two open chunks (park, airport, water) meet.
 */
export function laneOpen(axis: 'x' | 'z', line: number, t: number) {
  if (axis === 'z') {
    const k = Math.round(line / AX - 0.5);
    const cz = Math.round(t / SZ);
    return roadOpen(k, cz, '+x');
  }
  const k = Math.round(line / SZ - 0.5);
  const cx = Math.round(t / AX);
  return roadOpen(cx, k, '+z');
}

/**
 * For pedestrians: can people walk here? Everywhere in the city and the park; at the airport and
 * on the water only on the sidewalks of the roads that remain (and the waterfront promenade).
 */
export function walkable(x: number, z: number) {
  const cx = Math.round(x / AX), cz = Math.round(z / SZ);
  const d = districtAt(cx, cz);
  if (!d.open || d.open === 'park') return true;
  const lx = x - cx * AX, lz = z - cz * SZ;
  // the road and sidewalk band along each open edge
  if (roadOpen(cx, cz, '+x') && lx > AX / 2 - AVE / 2 - SW) return true;
  if (roadOpen(cx, cz, '-x') && lx < -AX / 2 + AVE / 2 + SW) return true;
  if (roadOpen(cx, cz, '+z') && lz > SZ / 2 - ST / 2 - SW) return true;
  if (roadOpen(cx, cz, '-z') && lz < -SZ / 2 + ST / 2 + SW) return true;
  if (d.kind === 'pier') return lx * (d.waterSide ?? 1) < PIER_SHORE;
  return false;
}
/** pier chunks: land (the riverside park) up to this local x, measured towards the water */
export const PIER_SHORE = -14;

/** weighted pick from a table */
export function pickW<K extends string>(r: Rng, table: Partial<Record<K, number>>, fallback: K): K {
  let tot = 0;
  for (const k in table) tot += table[k] ?? 0;
  if (tot <= 0) return fallback;
  let t = r.next() * tot;
  for (const k in table) if ((t -= table[k] ?? 0) < 0) return k;
  return fallback;
}

/** the district's shop for a storefront: an index into SHOPS */
export function shopPicker(d: District, types: string[]) {
  return (r: Rng) => {
    const t = pickW(r, d.shops, 'deli');
    const i = types.indexOf(t);
    return i >= 0 ? i : r.int(0, types.length - 1);
  };
}

/** hand-made map extent, for the lab's overview */
export const MAP_BOUNDS = { x0: MAP_X0, z0: MAP_Z0, w: MAP[0].length, h: MAP.length };
