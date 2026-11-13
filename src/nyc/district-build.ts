import * as THREE from 'three';
import type { Portal, Rect } from '../level';
import type { Rng } from '../rng';
import type { BCtx, BuildingStyle } from './buildings';
import { pickW, districtAtPos, spawnView, type District, type BType } from './districts';
import { openChunk } from './district-open';
import { customBlock } from './district-custom';
import { sidewalkDisplays } from './district-displays';
import { updateShowcases } from './district-showcase';
import { tickWater } from './district-tex';
import { neighbourhoodExtras } from './nbhd'; // [nbhd]

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
export function districtStyle(d: District, r: Rng, cx = 99, cz = 99): BuildingStyle {
  // three or four different types per building (a wide avenue building has 4+ storefronts);
  // storefront() never puts the same type in two neighbouring units
  const shops: string[] = [];
  for (let i = 0; i < 12 && shops.length < 4; i++) {
    const t = pickW(r, d.shops, 'deli');
    if (!shops.includes(t)) shops.push(t);
  }
  const s: BuildingStyle = { shops };
  if (d.kind === 'industrial') Object.assign(s, { fireEscape: 0.2, waterTower: 0.5, awning: 0.1, gate: 0.7 });
  if (d.kind === 'timesq') Object.assign(s, { signs: ['lightbox', 'letters'], awning: 0.2 });
  if (d.kind === 'canal' || d.kind === 'bowery') Object.assign(s, { awning: 0.8, gate: 0.6 });
  // the first view of the game: every shop open, lit signs, no roll-down gates
  if (spawnView(cx, cz)) Object.assign(s, { gate: 0, awning: 0.6 });
  return s;
}

/** which default frontages nyc.ts should still build: [west/east avenue ends], [north/south rows] */
export interface Plan {
  ave: [boolean, boolean];
  rows: [boolean, boolean];
  /** false: drop the block's hidden backyard box (a lot or yard opens the block up) */
  core?: boolean;
}
export { openChunk, customBlock };

/** after the street furniture: displays outside the shops, district props */
export function districtExtras(ctx: BCtx, d: District) {
  sidewalkDisplays(ctx, d);
  neighbourhoodExtras(ctx, d); // [nbhd] High Line, Meatpacking canopies, garment racks
}

export function updateDistricts(p: THREE.Vector3, time: number) {
  updateShowcases(p);
  tickWater(time);
  arrival(p, time);
}

/** what each neighbourhood shows off, for the arrival toast */
const TAGLINE: Partial<Record<District['kind'], string>> = {
  midtown: 'towers, delis and department stores', timesq: 'billboards, toys and electronics', music: '48th Street instrument shops', garment: 'sporting goods and supplies',
  bowery: 'restaurant supply and lighting', canal: 'electronics, tools and street stalls', market: 'greenmarket stalls', brownstone: 'stoops, gardens and stoop sales',
  industrial: 'rail and container yards', construction: 'cranes, machines and tools', museum: 'arms, armour, instruments and architecture', autorow: 'showrooms and car lots',
  park: 'lawns, playgrounds, the boat pond', airport: 'aircraft on the apron', pier: 'piers, boats and the carrier',
};
let shownKind = '', candidate = '', since = 0;
/** a HUD toast with the neighbourhood's name when the player walks into a new one */
function arrival(p: THREE.Vector3, time: number) {
  const d = districtAtPos(p.x, p.z);
  if (d.kind === 'river') return;
  if (!shownKind) {
    shownKind = d.kind; // no toast at the spawn
    return;
  }
  if (d.kind === shownKind) {
    candidate = '';
    return;
  }
  if (d.kind !== candidate) {
    candidate = d.kind;
    since = time;
    return;
  }
  if (time - since < 1.2) return; // linger a moment: no flicker at a border
  shownKind = d.kind;
  const el = typeof document !== 'undefined' ? document.getElementById('toast') : null;
  if (!el) return;
  el.textContent = `${d.name}${TAGLINE[d.kind] ? ` — ${TAGLINE[d.kind]}` : ''}`;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3400) as unknown as number;
}
let toastTimer = 0;
