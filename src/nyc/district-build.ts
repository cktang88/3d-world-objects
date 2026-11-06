import * as THREE from 'three';
import type { Portal, Rect } from '../level';
import type { Rng } from '../rng';
import type { BCtx, BuildingStyle } from './buildings';
import { pickW, type District, type BType } from './districts';
import { openChunk } from './district-open';
import { customBlock } from './district-custom';
import { sidewalkDisplays } from './district-displays';
import { updateShowcases } from './district-showcase';
import { tickWater } from './district-tex';

/**
 * The hooks nyc.ts calls while building a block: which building types, floors, shops and styles
 * a district gets, whole open chunks (park, airport, river), custom blocks (auto row lots,
 * construction sites, the greenmarket plaza, the museum) and the extras on the sidewalks.
 */

export interface DistrictChunk {
  group: THREE.Group;
  colliders: Rect[];
  portals: Portal[];
}

/** a building type for the avenue frontage */
export function aveType(d: District, r: Rng): BType {
  return pickW(r, d.ave, 'prewar');
}
/** a building type for the mid-block rows */
export function rowType(d: District, r: Rng): BType {
  return pickW(r, d.rows, 'tenement');
}
export function floorsFor(d: District, n: number) {
  return Math.max(2, Math.round(n * (d.floors ?? 1)));
}
/** style knobs for one building: its storefronts draw from the district's shop mix */
export function districtStyle(d: District, r: Rng): BuildingStyle {
  const shops = [pickW(r, d.shops, 'deli')];
  if (r.chance(0.35)) shops.push(pickW(r, d.shops, 'deli'));
  const s: BuildingStyle = { shops };
  if (d.kind === 'industrial') Object.assign(s, { fireEscape: 0.2, waterTower: 0.5, awning: 0.1, gate: 0.7 });
  if (d.kind === 'timesq') Object.assign(s, { signs: ['lightbox', 'letters'], awning: 0.2 });
  if (d.kind === 'canal' || d.kind === 'bowery') Object.assign(s, { awning: 0.8, gate: 0.6 });
  return s;
}

/** which default frontages nyc.ts should still build: [west/east avenue ends], [north/south rows] */
export interface Plan {
  ave: [boolean, boolean];
  rows: [boolean, boolean];
}
export { openChunk, customBlock };

/** after the street furniture: displays outside the shops, district props */
export function districtExtras(ctx: BCtx, d: District) {
  sidewalkDisplays(ctx, d);
}

export function updateDistricts(p: THREE.Vector3, time: number) {
  updateShowcases(p);
  tickWater(time);
}
