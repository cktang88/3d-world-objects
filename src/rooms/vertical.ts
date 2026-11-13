import * as THREE from 'three';
import type { Env, Level, LevelDesc, Portal, Rect } from '../level';
import { disposeTree, finishBuilding } from '../level';
import { Kit } from './kit';
import { lobbyStyleFor, furnishLobby, type LobbyStyle, type StaffPost, type LobbyBuilt } from './lobbies';
import { Person, loadPeopleAssets, type Uniform } from '../nyc/people';
import { updateShowcases } from '../nyc/district-showcase';
import { M } from './mats';
import * as F from './furniture';
import { Rng, hashN } from '../rng';
import { signTex, facade, roofTex } from '../textures';
import { mat } from '../build';
import { officeTypeFor, OFFICE_NAMES } from './office';

/**
 * Vertical circulation: a building as a stack of floor levels joined by a real stair and
 * elevators (see docs/research/vertical.md).
 *
 *  - `{ kind: 'floor', seed, name, type, floor, floors }`: floor 0 is the lobby, `floors` the roof.
 *    Every floor has the same plan in x/z, so changing floors only moves the player by H.
 *  - the stair is a periodic column: one storey (two flights, landings, walls, balusters, light)
 *    merged per material and drawn as InstancedMeshes, one instance per storey of the building.
 *  - `ground(x, z, y)` is the stair surface under you (periodic in H), used by Player.ground.
 *  - halls with apartment / office doors (portals into InteriorLevel, prebuilt by seamless.ts),
 *    lift fronts with sliding hall doors (animated by src/vertical.ts), lobbies, a tar roof with a
 *    bulkhead, water tower and a skyline.
 */

export type BType = 'walkup' | 'prewar' | 'office' | 'loft' | 'house';
export type FloorDesc = Extract<LevelDesc, { kind: 'floor' }>;

interface LiftSpec {
  side: 1 | -1;
  /** distance along the hall from the stair landing edge to the lift centre */
  at: number;
}
export interface Spec {
  H: number;
  risers: number;
  fw: number;
  gap: number;
  run: number;
  /** hall width (0: as wide as the stair) */
  hw: number;
  hallL: number;
  lifts: LiftSpec[];
  units: number;
  lobbyUnits: number;
  unitStyles: string[];
  /** fire stair behind a wall with a door (offices) instead of a stair open to the hall */
  enclosed: boolean;
  lobbyW: number;
  lobbyL: number;
  roofW: number;
  /** elevator speed, floors per second */
  speed: number;
}

export const SPECS: Record<BType, Spec> = {
  walkup: { H: 3.05, risers: 16, fw: 0.95, gap: 0.12, run: 0.25, hw: 0, hallL: 4.6, lifts: [], units: 4, lobbyUnits: 2, unitStyles: ['apartment'], enclosed: false, lobbyW: 0, lobbyL: 4.6, roofW: 8.5, speed: 1 },
  prewar: { H: 3.2, risers: 18, fw: 1.1, gap: 0.3, run: 0.27, hw: 1.9, hallL: 9.5, lifts: [{ side: 1, at: 8.3 }], units: 6, lobbyUnits: 2, unitStyles: ['apartment'], enclosed: false, lobbyW: 7, lobbyL: 7.5, roofW: 18, speed: 1.3 },
  office: { H: 3.9, risers: 22, fw: 1.15, gap: 0.25, run: 0.28, hw: 2.7, hallL: 10.5, lifts: [{ side: 1, at: 6.7 }, { side: 1, at: 9.0 }, { side: -1, at: 6.7 }, { side: -1, at: 9.0 }], units: 3, lobbyUnits: 0, unitStyles: ['office'], enclosed: true, lobbyW: 12, lobbyL: 9, roofW: 24, speed: 3 },
  /** a house's own stair (brownstone): a stair hall behind the back wall, wood treads, closed doors on other floors (InteriorLevel, houseCore()) */
  house: { H: 3.35, risers: 18, fw: 0.95, gap: 0.1, run: 0.26, hw: 0, hallL: 0, lifts: [], units: 0, lobbyUnits: 0, unitStyles: [], enclosed: true, lobbyW: 0, lobbyL: 0, roofW: 0, speed: 1 },
  loft: { H: 3.8, risers: 22, fw: 1.1, gap: 0.2, run: 0.27, hw: 2.2, hallL: 5.5, lifts: [{ side: 1, at: 4.1 }], units: 2, lobbyUnits: 1, unitStyles: ['office', 'workshop', 'apartment'], enclosed: true, lobbyW: 6.5, lobbyL: 6, roofW: 12, speed: 0.8 },
};

const T = 0.2; // wall thickness
const S = 0.22; // floor slab
const DW = 0.95; // unit door
const DH = 2.13;
export const LIFT = { w: 1.6, d: 1.4, h: 2.4, door: 1.0, depth: 0.2 };

/** the NYC building type (src/nyc/buildings.ts) -> a building of floors, or null (brownstones keep their own interiors) */
export function buildingType(nycType: string, style: string, floors: number): BType | null {
  if (nycType === 'brownstone') return null;
  if (nycType === 'tower') return 'office';
  if (nycType === 'castiron') return 'loft';
  if (style === 'office' && nycType !== 'tenement') return 'office';
  if (nycType === 'tenement') return 'walkup';
  if (nycType === 'prewar') return 'prewar';
  return floors > 6 ? 'prewar' : 'walkup';
}
/** the level desc for a building's lobby */
export function buildingDesc(nycType: string, style: string, seed: number, name: string, floors: number, district?: string): LevelDesc | null {
  const type = buildingType(nycType, style, floors);
  if (!type) return null;
  return { kind: 'floor', seed, name, type, floor: 0, floors: Math.max(2, Math.min(floors, 40)), ...(district ? { district } : {}) };
}

export function floorLabel(type: string, f: number, floors: number) {
  if (f >= floors) return 'R';
  if (f === 0) return type === 'office' || type === 'prewar' ? 'L' : '1';
  return String(f + 1);
}
export function floorName(d: FloorDesc) {
  if (d.floor >= d.floors) return `${d.name} · roof`;
  if (d.floor === 0) return `${d.name} · lobby`;
  return `${d.name} · floor ${d.floor + 1}`;
}

// ---------------------------------------------------------------- stair dimensions

export interface Dims {
  H: number;
  rise: number;
  /** risers per flight */
  k: number;
  run: number;
  /** flight length (treads) */
  Lf: number;
  /** landing depths: floor (L) and half (M) */
  Ld: number;
  Md: number;
  fw: number;
  gap: number;
  SW: number;
  hw: number;
  /** strip A (flight up from the floor landing) and B (flight up from the half landing) */
  ax0: number;
  ax1: number;
  bx0: number;
  bx1: number;
  zBack: number;
  /** hall ceiling */
  Hc: number;
  /** far end of the hall, street door */
  zH1: number;
  zS: number;
  lw: number;
}

export function dims(s: Spec): Dims {
  const n = s.risers % 2 ? s.risers + 1 : s.risers;
  const k = n / 2;
  const rise = s.H / n;
  const Lf = (k - 1) * s.run;
  const SW = 2 * s.fw + s.gap;
  const Ld = Math.max(1.2, s.fw + 0.25);
  const Md = Math.max(1.1, s.fw + 0.1);
  const hw = s.hw || SW;
  const zH1 = Ld + s.hallL;
  return {
    H: s.H, rise, k, run: s.run, Lf, Ld, Md, fw: s.fw, gap: s.gap, SW, hw,
    ax0: -SW / 2, ax1: -SW / 2 + s.fw, bx0: SW / 2 - s.fw, bx1: SW / 2,
    zBack: -Lf - Md, Hc: s.enclosed ? 2.8 : s.H - S, zH1, zS: zH1 + s.lobbyL, lw: Math.max(s.lobbyW, hw),
  };
}

/** height of the stair surface under (x, z) within one storey, 0..H (null: not on the stair) */
export function stairHeight(d: Dims, x: number, z: number): number | null {
  if (z < 0 && z > -d.Lf) {
    const s = -z / d.Lf;
    if (x >= d.ax0 - 0.1 && x <= -d.gap / 2) return (d.H / 2) * s;
    if (x >= d.gap / 2 && x <= d.bx1 + 0.1) return d.H - (d.H / 2) * s;
    // in the well (between the rails): the nearer flight
    if (Math.abs(x) < d.gap / 2) return x < 0 ? (d.H / 2) * s : d.H - (d.H / 2) * s;
    return null;
  }
  if (z <= -d.Lf && z >= d.zBack - 0.1 && Math.abs(x) <= d.SW / 2 + 0.1) return d.H / 2;
  return null;
}

/** the walkable height near y (periodic stair, flat floor elsewhere) */
export function groundAt(d: Dims, x: number, z: number, y: number) {
  const f = stairHeight(d, x, z) ?? 0;
  return f + d.H * Math.round((y - f) / d.H);
}

// ---------------------------------------------------------------- canvas helpers

function canvas(w: number, h = w): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}
const memo = new Map<string, unknown>();
function cached<T>(key: string, make: () => T): T {
  if (!memo.has(key)) memo.set(key, make());
  return memo.get(key) as T;
}
function canvasTex(c: HTMLCanvasElement, repeat = false) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/** terrazzo: cement with marble chips, one repeat = 0.6 m */
function terrazzoMat(base: string, seed: number) {
  return cached(`terrazzo:${base}:${seed}`, () => {
    const [c, g] = canvas(512);
    g.fillStyle = base;
    g.fillRect(0, 0, 512, 512);
    const r = new Rng(seed);
    const chips = ['#f2efe8', '#c9c2b4', '#6e6a62', '#a89070', '#3a3836', '#d8cbb0', '#8a7a68'];
    for (let i = 0; i < 5200; i++) {
      g.fillStyle = r.pick(chips);
      const x = r.range(0, 512), y = r.range(0, 512), s = r.range(1.5, 6);
      g.beginPath();
      g.moveTo(x, y);
      for (let k = 1; k < 5; k++) g.lineTo(x + Math.cos(k * 1.3 + i) * s * r.range(0.6, 1.2), y + Math.sin(k * 1.3 + i) * s * r.range(0.6, 1.2));
      g.fill();
    }
    const t = canvasTex(c, true);
    t.repeat.set(1 / 0.6, 1 / 0.6);
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.32 });
  });
}
/** painted concrete block (CMU), 0.4 x 0.2 m courses */
function cmuMat(color: string) {
  return cached(`cmu:${color}`, () => {
    const [c, g] = canvas(256);
    g.fillStyle = color;
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = 'rgba(0,0,0,0.13)';
    for (let y = 0; y < 256; y += 64) {
      g.fillRect(0, y, 256, 3);
      const off = (y / 64) % 2 ? 64 : 0;
      for (let x = off; x < 256 + 128; x += 128) g.fillRect(x % 256, y, 3, 64);
    }
    const r = new Rng(9);
    for (let i = 0; i < 1800; i++) {
      g.fillStyle = `rgba(${r.chance(0.5) ? '0,0,0' : '255,255,255'},${r.range(0.02, 0.06)})`;
      g.fillRect(r.range(0, 256), r.range(0, 256), 2, 2);
    }
    const t = canvasTex(c, true);
    t.repeat.set(1 / 0.8, 1 / 0.8);
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.9 });
  });
}
/** a glyph atlas for stencilled / plaque floor numbers: '0'-'9', 'L', 'R', 'B', ' ' */
const GLYPHS = '0123456789LRB ';
function glyphMat(color: string, stencil: boolean) {
  return cached(`glyphs:${color}:${stencil}`, () => {
    const [c, g] = canvas(64 * GLYPHS.length, 96);
    g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = '#ffffff';
    g.font = stencil ? 'bold 84px Impact, "Arial Black", sans-serif' : 'bold 80px Georgia, serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let i = 0; i < GLYPHS.length; i++) g.fillText(GLYPHS[i], i * 64 + 32, 52, 60);
    if (stencil) {
      // stencil bridges
      g.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < GLYPHS.length; i++) g.fillRect(i * 64 + 29, 0, 5, 96);
    }
    const t = canvasTex(c);
    return new THREE.MeshStandardMaterial({ map: t, color, transparent: true, alphaTest: 0.4, roughness: 0.8, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  });
}
function glyphQuad(ch: string, w: number, h: number) {
  const i = Math.max(0, GLYPHS.indexOf(ch));
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let k = 0; k < uv.count; k++) uv.setX(k, (i + uv.getX(k)) / GLYPHS.length);
  return g;
}

/**
 * The lit floor indicator over every lift door and inside the cab (one shared texture: one car per
 * building is ever on show). src/vertical.ts redraws it as the car moves.
 */
export const liftDisplay = (() => {
  let c: HTMLCanvasElement | null = null, g: CanvasRenderingContext2D | null = null;
  let texture: THREE.CanvasTexture | null = null;
  let material: THREE.MeshStandardMaterial | null = null;
  let last = '';
  const init = () => {
    if (material) return;
    [c, g] = canvas(256, 96);
    texture = canvasTex(c);
    material = new THREE.MeshStandardMaterial({ color: '#000000', emissive: '#ffffff', emissiveMap: texture, map: texture, roughness: 0.3 });
  };
  return {
    get mat() {
      init();
      return material!;
    },
    draw(label: string, dir: number) {
      init();
      const key = `${label}|${dir}`;
      if (key === last) return;
      last = key;
      g!.fillStyle = '#120404';
      g!.fillRect(0, 0, 256, 96);
      g!.fillStyle = '#ff3a2a';
      g!.font = 'bold 72px "Courier New", monospace';
      g!.textAlign = 'center';
      g!.textBaseline = 'middle';
      g!.fillText(label, 128, 52);
      g!.globalAlpha = dir ? 1 : 0.18;
      for (const s of [-1, 1]) {
        const x = s < 0 ? 34 : 222;
        const up = dir > 0 || (!dir && s < 0);
        g!.beginPath();
        if (up) {
          g!.moveTo(x - 18, 62); g!.lineTo(x + 18, 62); g!.lineTo(x, 32);
        } else {
          g!.moveTo(x - 18, 34); g!.lineTo(x + 18, 34); g!.lineTo(x, 64);
        }
        g!.fill();
      }
      g!.globalAlpha = 1;
      texture!.needsUpdate = true;
    },
  };
})();

/** a lift-panel canvas (buttons for every floor), for the cab */
export function panelTexture(type: string, floors: number, selected: number, here: number) {
  const cols = floors > 12 ? 3 : 2;
  const rows = Math.ceil(floors / cols);
  const cw = 64, rh = 52;
  const [c, g] = canvas(cols * cw + 24, rows * rh + 60);
  g.fillStyle = type === 'office' ? '#b9bec3' : '#a8834d';
  g.fillRect(0, 0, c.width, c.height);
  g.font = 'bold 22px Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let f = 0; f < floors; f++) {
    const col = f % cols, row = rows - 1 - Math.floor(f / cols);
    const x = 12 + col * cw + cw / 2, y = 30 + row * rh + rh / 2;
    g.fillStyle = f === selected ? '#ffd27a' : f === here ? '#f0ebe0' : '#2a2620';
    g.beginPath();
    g.arc(x, y, 19, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#e8d8b0';
    g.lineWidth = 3;
    g.stroke();
    g.fillStyle = f === selected ? '#3a1a00' : f === here ? '#2a2620' : '#f0e8d0';
    g.fillText(floorLabel(type, f, floors), x, y + 1);
  }
  g.fillStyle = '#7a1a10';
  g.beginPath();
  g.arc(c.width / 2, 16, 10, 0, Math.PI * 2);
  g.fill();
  return { tex: canvasTex(c), aspect: c.width / c.height };
}

// ---------------------------------------------------------------- per-building materials

interface Mats {
  tread: THREE.Material;
  riser: THREE.Material;
  stringer: THREE.Material;
  baluster: THREE.Material;
  rail: THREE.Material;
  soffit: THREE.Material;
  landing: THREE.Material;
  wall: THREE.Material;
  hallWall: THREE.Material;
  wainscot: THREE.Material | null;
  hallFloor: THREE.Material;
  lobbyFloor: THREE.Material;
  trim: THREE.Material;
  door: THREE.Material;
  ceiling: THREE.Material;
  liftDoor: THREE.Material;
  surround: THREE.Material;
  bulb: THREE.Material;
  glyph: THREE.Material;
  steel: boolean;
}

function mats(type: BType, seed: number): Mats {
  const r = new Rng(hashN(seed, 404));
  const paint = (c: string) => M.paint(c);
  switch (type) {
    case 'walkup': {
      const upper = r.pick(['#d9cfae', '#cfd3c0', '#d8c9a8', '#c7cdb8', '#e0d6bd']);
      const lower = r.pick(['#3d4a3a', '#5a3a2a', '#4a3a30', '#2f3d45', '#6a5a3a']);
      return {
        tread: M.marble('#d8d0c0'), riser: M.iron(), stringer: M.iron(), baluster: M.iron(), rail: M.walnut('#8a6a50'),
        soffit: paint(upper), landing: M.hex(), wall: paint(upper), hallWall: paint(upper), wainscot: M.painted(lower),
        hallFloor: M.hex(), lobbyFloor: M.hex(), trim: M.painted(lower), door: M.painted(r.pick(['#5a2a1e', '#2f3a40', '#3b2a20', '#6a5a48'])),
        ceiling: paint('#ece6d6'), liftDoor: M.steel(), surround: M.painted(lower), bulb: M.bulb(), glyph: glyphMat('#2a2420', false), steel: false,
      };
    }
    case 'prewar': {
      const wall = r.pick(['#e6dcc6', '#ddd6c4', '#e8e0cc', '#d6d0c0']);
      return {
        tread: M.marble('#efe9de'), riser: M.marble('#e6e0d4'), stringer: M.iron(), baluster: M.iron(), rail: M.walnut('#9a7a5a'),
        soffit: paint('#ece8de'), landing: terrazzoMat('#b9b0a0', seed), wall: paint(wall), hallWall: paint(wall), wainscot: M.marble('#d9cfbd'),
        hallFloor: terrazzoMat('#b9b0a0', seed), lobbyFloor: terrazzoMat(r.pick(['#a89a86', '#9a8e7c', '#b8ad98']), seed + 1), trim: M.walnut('#7a5a40'),
        door: M.painted(r.pick(['#3a2a20', '#2a3530', '#4a3020', '#1e2a35'])), ceiling: paint('#f2eee4'), liftDoor: M.brass(), surround: M.brass(), bulb: M.bulb(),
        glyph: glyphMat('#1e1a16', false), steel: false,
      };
    }
    case 'house': {
      const wall = r.pick(['#e8dcc8', '#d9e0d4', '#e6d3c3', '#efe7d6']);
      return {
        tread: M.oak('#9a7050'), riser: M.trim(), stringer: M.trim(), baluster: M.walnut('#6a4a30'), rail: M.walnut('#6a4a30'),
        soffit: paint('#f2eee4'), landing: M.parquet(), wall: paint(wall), hallWall: paint(wall), wainscot: null,
        hallFloor: M.parquet(), lobbyFloor: M.parquet(), trim: M.trim(), door: M.painted(r.pick(['#3b2a20', '#2f3a40', '#f1eee6'])),
        ceiling: paint('#f4f2ec'), liftDoor: M.steel(), surround: M.trim(), bulb: M.bulb(), glyph: glyphMat('#2a2420', false), steel: false,
      };
    }
    case 'office':
    case 'loft': {
      const block = r.pick(['#d6d6cf', '#dad4c4', '#cfd4d6', '#e2ddcc']);
      const steel = mat(r.pick(['#4a5560', '#5a5f63', '#3e4a52', '#6a6258']), { rough: 0.55, metal: 0.3 });
      return {
        tread: mat('#8e8c86', { rough: 0.9 }), riser: steel, stringer: steel, baluster: steel, rail: mat(r.pick(['#c9a52a', '#4a5560', '#b0b4b8']), { rough: 0.4, metal: 0.4 }),
        soffit: steel, landing: mat('#8e8c86', { rough: 0.9 }), wall: cmuMat(block), hallWall: paint(type === 'office' ? '#e9e9e6' : '#dcd8cf'), wainscot: null,
        hallFloor: type === 'office' ? M.carpetTile(r.pick(['#4a4d52', '#5a5048', '#3d4650'])) : mat('#9a958c', { rough: 0.7 }),
        lobbyFloor: type === 'office' ? M.marble(r.pick(['#4a4846', '#6a6560', '#d8d2c8'])) : mat('#8a857c', { rough: 0.7 }),
        trim: M.matte('#5a5e62'), door: M.matte(r.pick(['#5a5e62', '#3a4a5a', '#6a3a30'])), ceiling: M.dropCeiling(), liftDoor: M.steel(), surround: M.steel(), bulb: M.troffer(),
        glyph: glyphMat('#b8221a', true), steel: true,
      };
    }
  }
}

// ---------------------------------------------------------------- the stair column (shared per building)

interface Column {
  segment: THREE.Mesh[];
  base: THREE.Mesh[];
  cap: THREE.Mesh[];
  stub: THREE.Mesh[];
  users: number;
}
const columns = new Map<string, Column>();

function meshes(k: Kit): THREE.Mesh[] {
  const g = new THREE.Group();
  k.finish(g);
  return g.children as THREE.Mesh[];
}

/** one storey of stair: floor landing at y = 0 .. the next floor's landing at y = H */
function buildSegment(k: Kit, d: Dims, m: Mats, s: Spec) {
  const { H, rise, k: K, run, Lf, Md, SW, Ld, fw, gap, zBack } = d;
  const ax = (d.ax0 + d.ax1) / 2, bx = (d.bx0 + d.bx1) / 2;
  // floor landing slab (its top finish) and half landing
  k.box(m.soffit, SW, S - 0.025, Ld, 0, -S, Ld / 2);
  k.box(m.landing, SW, 0.025, Ld, 0, -0.025, Ld / 2);
  k.box(m.soffit, SW, S - 0.025, Md, 0, H / 2 - S, -Lf - Md / 2);
  k.box(m.landing, SW, 0.025, Md, 0, H / 2 - 0.025, -Lf - Md / 2);
  const ang = Math.atan2(H / 2, Lf);
  const hyp = Math.hypot(H / 2, Lf);
  // flights: A from z = 0 (y 0) to z = -Lf (y H/2); B from z = -Lf (y H/2) to z = 0 (y H)
  for (const fl of [0, 1]) {
    const x = fl ? bx : ax;
    for (let i = 0; i < K - 1; i++) {
      const top = (fl ? H / 2 : 0) + (i + 1) * rise;
      const z0 = fl ? -Lf + i * run : -(i + 1) * run; // tread extent
      const z1 = z0 + run;
      const riserZ = fl ? z0 : z1;
      const nose = fl ? -0.025 : 0.025;
      if (m.steel) {
        // steel pan, concrete fill, angle nosing
        k.box(m.tread, fw - 0.02, 0.04, run, x, top - 0.04, (z0 + z1) / 2);
        k.box(m.riser, fw - 0.02, rise - 0.04, 0.008, x, top - rise, riserZ);
        k.box(m.riser, fw - 0.02, 0.012, 0.04, x, top - 0.012, riserZ + nose);
      } else {
        k.box(m.riser, fw, rise + 0.2, 0.03, x, top - rise - 0.2, riserZ);
        k.box(m.tread, fw + 0.01, 0.035, run + 0.03, x, top - 0.035, (z0 + z1) / 2 + nose / 2);
        // worn hollow in the middle of old marble treads (a slightly darker inset)
        if (!fl || i % 2 === 0) k.box(M.marble('#c9c0ae'), fw * 0.4, 0.002, run * 0.5, x, top, (z0 + z1) / 2);
      }
    }
    const cy = (fl ? H / 2 : 0) + H / 4;
    const tilt = new THREE.Euler(fl ? -ang : ang, 0, 0);
    if (m.steel) {
      // channel stringers both sides
      for (const sx of [-1, 1]) k.boxM(m.stringer, 0.05, 0.3, hyp + 0.2, x + sx * (fw / 2 - 0.025), cy - 0.05, -Lf / 2, tilt);
    } else {
      k.boxM(m.soffit, fw, 0.12, hyp + 0.1, x, cy - 0.24, -Lf / 2, tilt);
      // the open (well-side) stringer
      k.boxM(m.stringer, 0.04, 0.26, hyp + 0.1, fl ? d.bx0 + 0.02 : d.ax1 - 0.02, cy - 0.1, -Lf / 2, tilt);
    }
    // balusters and handrail along the well
    const ex = fl ? d.bx0 + 0.035 : d.ax1 - 0.035;
    if (m.steel) {
      for (const hh of [0.45, 0.95]) k.boxM(m.rail, 0.042, 0.042, hyp, ex, cy + hh, -Lf / 2, tilt);
      for (const zz of [-0.05, -Lf + 0.05]) {
        const y0 = zz > -Lf / 2 ? (fl ? H : 0) : H / 2;
        k.box(m.rail, 0.045, 1.0, 0.045, ex, y0, zz);
      }
    } else {
      for (let i = 0; i < K - 1; i++) {
        const top = (fl ? H / 2 : 0) + (i + 1) * rise;
        const z0 = fl ? -Lf + i * run : -(i + 1) * run;
        for (const t of [0.25, 0.75]) {
          const zz = z0 + run * t;
          const sOn = fl ? (zz + Lf) / Lf : -zz / Lf;
          const railY = (fl ? H / 2 : 0) + (H / 2) * sOn + 0.9;
          k.box(m.baluster, 0.016, railY - top, 0.016, ex, top, zz);
        }
      }
      k.boxM(m.rail, 0.06, 0.055, hyp + 0.12, ex, cy + 0.92, -Lf / 2, tilt);
    }
  }
  // newel posts and the rails across the well end at the half landing
  const newel = (x: number, y: number, z: number) => {
    if (m.steel) k.box(m.rail, 0.05, 1.0, 0.05, x, y, z);
    else {
      k.box(m.baluster, 0.09, 0.95, 0.09, x, y, z);
      k.sphere(m.baluster, 0.06, x, y + 1.0, z);
    }
  };
  newel(d.ax1 - 0.035, 0, -0.03);
  newel(d.bx0 + 0.035, H / 2, -Lf - 0.03);
  newel(d.ax1 - 0.035, H / 2, -Lf - 0.03);
  k.box(m.rail, gap + 0.08, 0.05, 0.05, 0, H / 2 + 0.92, -Lf - 0.03);
  // walls
  const zFront = s.enclosed ? Ld + T : Ld;
  const wl = zFront - (zBack - T);
  k.box(m.wall, T, H, wl, -SW / 2 - T / 2, 0, (zFront + zBack - T) / 2);
  k.box(m.wall, T, H, wl, SW / 2 + T / 2, 0, (zFront + zBack - T) / 2);
  k.box(m.wall, SW + 2 * T, H, T, 0, 0, zBack - T / 2);
  if (s.enclosed) {
    // the stair door wall (door 1.0 m in the middle)
    const half = (SW + 2 * T) / 2;
    const dw = 1.0;
    k.box(m.wall, half - dw / 2, H, T, -(half + dw / 2) / 2, 0, Ld + T / 2);
    k.box(m.wall, half - dw / 2, H, T, (half + dw / 2) / 2, 0, Ld + T / 2);
    k.box(m.wall, dw, H - DH, T, 0, DH, Ld + T / 2);
    k.box(m.trim, dw + 0.1, 0.05, T + 0.02, 0, DH, Ld + T / 2);
  } else if (d.hw < SW) {
    const a = d.hw / 2, b = SW / 2 + T;
    for (const sx of [-1, 1]) k.box(m.wall, b - a, H, T, sx * (a + b) / 2, 0, Ld + T / 2);
  }
  // light: a bracket globe on the back wall over the half landing, or fluorescent strips under the landings
  if (m.steel) {
    k.box(M.matte('#d8d8d4'), 1.25, 0.06, 0.16, 0, H / 2 - S - 0.06, -Lf - Md / 2);
    k.box(m.bulb, 1.15, 0.015, 0.1, 0, H / 2 - S - 0.075, -Lf - Md / 2);
    k.box(M.matte('#d8d8d4'), 1.25, 0.06, 0.16, 0, -S - 0.06, Ld / 2);
    k.box(m.bulb, 1.15, 0.015, 0.1, 0, -S - 0.075, Ld / 2);
  } else {
    k.box(M.brass(), 0.08, 0.08, 0.14, 0, H / 2 + 2.05, zBack + 0.07);
    k.sphere(M.diffuser(), 0.11, 0, H / 2 + 2.05, zBack + 0.2);
  }
}

/** under the lowest flight: a floor and the closed-off way down to the cellar */
function buildBase(k: Kit, d: Dims, m: Mats) {
  const { SW, Lf, Md, zBack, H, rise, run, k: K } = d;
  k.box(m.landing, SW, 0.02, Lf + Md, 0, -0.02, (zBack + 0) / 2);
  const w = d.bx1 - d.gap / 2;
  const cx = (d.bx1 + d.gap / 2) / 2;
  const wallH = Math.min(2.6, H - 0.45);
  k.box(m.wall, w, wallH, 0.1, cx, 0, -0.06);
  k.at(cx - 0.4, 0, -0.005, 0, () => F.doorLeaf(k, 0.8, 2.0, m.door));
  // skirt under flight B (stepped, following the flight)
  for (let i = 0; i < K - 1; i++) {
    const z = -Lf + (i + 0.5) * run;
    k.box(m.wall, 0.06, H / 2 + i * rise - 0.2, run, d.gap / 2 + 0.03, 0, z);
  }
}

/** the top: the roof landing inside the bulkhead, its walls, roof slab and skylight */
function buildCap(k: Kit, d: Dims, m: Mats, roofDoor: boolean) {
  const { SW, Ld, Lf, zBack } = d;
  const h = roofDoor ? 2.7 : d.H - S;
  k.box(m.soffit, SW, S - 0.025, Ld, 0, -S, Ld / 2);
  k.box(m.landing, SW, 0.025, Ld, 0, -0.025, Ld / 2);
  const zF = Ld + T;
  const wl = zF - (zBack - T);
  k.box(m.wall, T, h, wl, -SW / 2 - T / 2, 0, (zF + zBack - T) / 2);
  k.box(m.wall, T, h, wl, SW / 2 + T / 2, 0, (zF + zBack - T) / 2);
  k.box(m.wall, SW + 2 * T, h, T, 0, 0, zBack - T / 2);
  // door to the roof on the +x side of the front wall (a house's top landing: its doorway in the middle)
  const d0 = roofDoor ? SW / 2 - 1.0 : -0.5, d1 = roofDoor ? SW / 2 - 0.1 : 0.5;
  const x0 = -SW / 2 - T, x1 = SW / 2 + T;
  const dh = roofDoor ? 2.05 : DH;
  k.box(m.wall, d0 - x0, h, T, (x0 + d0) / 2, 0, Ld + T / 2);
  k.box(m.wall, x1 - d1, h, T, (x1 + d1) / 2, 0, Ld + T / 2);
  k.box(m.wall, d1 - d0, h - dh, T, (d0 + d1) / 2, dh, Ld + T / 2);
  // the door, swung open against the outside wall
  if (roofDoor) k.at(d1, 0, Ld + T + 0.02, -Math.PI / 2 - 0.15, () => F.doorLeaf(k, d1 - d0 - 0.02, 2.02, M.painted('#4a3a30')));
  // roof slab with a skylight over the well
  if (roofDoor) k.box(mat('#3a3a3c', { rough: 0.9 }), SW + 2 * T + 0.2, 0.22, wl + 0.2, 0, h, (zF + zBack - T) / 2);
  k.box(m.ceiling, SW, 0.01, wl - 2 * T, 0, h - 0.01, (zF + zBack - T) / 2);
  k.unshadowed(() => k.box(mat('#eef4f6', { emissive: '#dfeaf2', ei: 1.4, rough: 0.5 }), Math.min(1.4, SW - 0.4), 0.02, Lf * 0.8, 0, h - 0.03, -Lf / 2));
  // guard over the (missing) flight up
  k.box(m.rail, d.fw + 0.05, 0.05, 0.05, (d.ax0 + d.ax1) / 2, 1.0, -0.03);
  k.box(m.rail, d.fw + 0.05, 0.04, 0.04, (d.ax0 + d.ax1) / 2, 0.5, -0.03);
  for (let x = d.ax0 + 0.1; x < d.ax1; x += m.steel ? 0.5 : 0.12) k.box(m.baluster, 0.016, 1.0, 0.016, x, 0, -0.03);
  k.box(m.baluster, 0.05, 1.05, 0.05, d.ax1 - 0.035, 0, -0.03);
}

/** a far floor seen through the stairwell: a short stub of hall with a closed door */
function buildStub(k: Kit, d: Dims, m: Mats, s: Spec) {
  if (s.enclosed) {
    k.at(-0.48, 0, d.Ld + T / 2, 0, () => F.doorLeaf(k, 0.96, DH - 0.02, M.matte('#8a2a20')));
    return;
  }
  const w = Math.min(d.hw, d.SW), L = 1.6;
  k.box(m.hallFloor, w, 0.02, L, 0, -0.02, d.Ld + L / 2);
  k.box(m.ceiling, w, 0.02, L, 0, d.Hc, d.Ld + L / 2);
  for (const sx of [-1, 1]) k.box(m.hallWall, 0.1, d.Hc, L, sx * (w / 2 + 0.05), 0, d.Ld + L / 2);
  k.box(m.hallWall, w + 0.2, d.Hc, 0.1, 0, 0, d.Ld + L + 0.05);
  k.at(-DW / 2, 0, d.Ld + L, 0, () => F.doorLeaf(k, DW, DH, m.door));
  k.unshadowed(() => k.sphere(M.diffuser(), 0.12, 0, d.Hc - 0.1, d.Ld + L / 2, 0.6));
}

/** the building's stair column, built once (in slices) and shared by all its floors */
function* columnFor(key: string, d: Dims, m: Mats, s: Spec, roofDoor = true): Generator<void, Column> {
  let c = columns.get(key);
  if (!c) {
    const ks = new Kit(), kb = new Kit(), kc = new Kit(), kt = new Kit();
    buildSegment(ks, d, m, s);
    yield;
    const segment = meshes(ks);
    yield;
    buildBase(kb, d, m);
    buildCap(kc, d, m, roofDoor);
    buildStub(kt, d, m, s);
    yield;
    // another floor of the same building may have finished it meanwhile
    c = columns.get(key) ?? { segment, base: meshes(kb), cap: meshes(kc), stub: meshes(kt), users: 0 };
    columns.set(key, c);
  }
  c.users++;
  return c;
}
function releaseColumn(key: string) {
  const c = columns.get(key);
  if (!c) return;
  if (--c.users > 0) return;
  columns.delete(key);
  for (const list of [c.segment, c.base, c.cap, c.stub]) for (const m of list) m.geometry.dispose();
}

function instanced(src: THREE.Mesh[], ys: number[], into: THREE.Object3D) {
  const out: THREE.InstancedMesh[] = [];
  const m = new THREE.Matrix4();
  for (const s of src) {
    const im = new THREE.InstancedMesh(s.geometry, s.material, Math.max(1, ys.length));
    ys.forEach((y, i) => im.setMatrixAt(i, m.makeTranslation(0, y, 0)));
    if (!ys.length) im.count = 0;
    im.castShadow = s.castShadow;
    im.receiveShadow = true;
    im.computeBoundingSphere();
    im.userData.shared = true;
    into.add(im);
    out.push(im);
  }
  return out;
}

/** the stair's colliders in its own frame: walls, the well, no flight down at the bottom, none up at the top */
export function stairRects(d: Dims, s: Spec, bottom: boolean, top: boolean, roofDoor: boolean): Rect[] {
  // (side walls stop where the back and front walls begin: no overlapping rects)
  const zF = d.Ld;
  const c: Rect[] = [];
  c.push({ minX: -d.SW / 2 - T, maxX: -d.SW / 2, minZ: d.zBack, maxZ: zF });
  c.push({ minX: d.SW / 2, maxX: d.SW / 2 + T, minZ: d.zBack, maxZ: zF });
  c.push({ minX: -d.SW / 2 - T, maxX: d.SW / 2 + T, minZ: d.zBack - T, maxZ: d.zBack });
  // the well between the flights
  const g = Math.max(0.04, d.gap / 2);
  c.push({ minX: -g, maxX: g, minZ: -d.Lf, maxZ: -0.02 });
  // bottom: the flight down is the cellar door; top: there is no flight up
  if (bottom) c.push({ minX: d.gap / 2, maxX: d.SW / 2, minZ: -0.6 * d.Lf, maxZ: -0.02 });
  if (top) c.push({ minX: -d.SW / 2, maxX: -d.gap / 2, minZ: -0.6 * d.Lf, maxZ: -0.02 });
  if (top && roofDoor) {
    // bulkhead front wall with its door on the +x side
    c.push({ minX: -d.SW / 2 - T, maxX: d.SW / 2 - 1.0, minZ: d.Ld, maxZ: d.Ld + T });
    c.push({ minX: d.SW / 2 - 0.1, maxX: d.SW / 2 + T, minZ: d.Ld, maxZ: d.Ld + T });
  } else if (s.enclosed || top) {
    c.push({ minX: -d.SW / 2 - T, maxX: -0.5, minZ: d.Ld, maxZ: d.Ld + T });
    c.push({ minX: 0.5, maxX: d.SW / 2 + T, minZ: d.Ld, maxZ: d.Ld + T });
  } else if (d.hw < d.SW) {
    c.push({ minX: -d.SW / 2 - T, maxX: -d.hw / 2, minZ: d.Ld, maxZ: d.Ld + T });
    c.push({ minX: d.hw / 2, maxX: d.SW / 2 + T, minZ: d.Ld, maxZ: d.Ld + T });
  }
  return c;
}

/**
 * What src/vertical.ts needs of a level with a stair (a FloorLevel, or an InteriorLevel with a
 * HouseCore attached as `level.vcore`).
 */
export interface VCore {
  /** floor to floor */
  H: number;
  floor: number;
  /** the highest floor index (a building's roof, a house's top floor) */
  top: number;
  /** floors served by the lifts */
  floors: number;
  /** the same for every floor of one building */
  key: string;
  type: string;
  speed: number;
  well: THREE.Group;
  lifts: LiftFront[];
  extra: Portal[];
  rideTarget: LevelDesc | null;
  ground(x: number, z: number, y: number): number;
  nearStair(p: THREE.Vector3): boolean;
  neighbour(dir: number): LevelDesc | null;
  setStub(dir: number, hidden: boolean): void;
  /** the desc of floor f of this building */
  at(f: number): LevelDesc;
}
export function coreOf(lv: Level | null | undefined): VCore | null {
  return (lv as { vcore?: VCore } | null)?.vcore ?? null;
}

/** far floors' landing stubs and their per-floor hiding */
class Stubs {
  list: THREE.InstancedMesh[] = [];
  ys: number[] = [];
  hidden = new Set<number>();
  constructor(public floor: number) {}
  set(dir: number, hidden: boolean) {
    const j = this.floor + dir;
    if (hidden === this.hidden.has(j)) return;
    if (hidden) this.hidden.add(j);
    else this.hidden.delete(j);
    this.apply();
  }
  apply() {
    const m = new THREE.Matrix4();
    for (const im of this.list) {
      this.ys.forEach((y, j) => im.setMatrixAt(j, this.hidden.has(j) || j === this.floor ? m.makeScale(0, 0, 0) : m.makeTranslation(0, y, 0)));
      im.instanceMatrix.needsUpdate = true;
    }
  }
}

/**
 * A house's stair (brownstones): a stair hall attached behind the back wall (bounds.z0) of an
 * InteriorLevel, the same on every floor, its doorway near the -x corner (no BSP wall ends within
 * 2 m of a corner). interior.ts reserves the doorway and adds the colliders; src/vertical.ts does
 * the climbing, the prefetch of the floors above/below and showing them through the doorways.
 */
export class HouseCore implements VCore {
  readonly d: Dims;
  readonly spec = SPECS.house;
  readonly H: number;
  readonly floor: number;
  readonly top: number;
  readonly floors: number;
  readonly key: string;
  readonly type = 'house';
  readonly speed = 1;
  well = new THREE.Group();
  lifts: LiftFront[] = [];
  extra: Portal[] = [];
  rideTarget: LevelDesc | null = null;
  /** the doorway in the back wall (level coordinates): centre x, wall line z, clear width */
  door: { x: number; z: number; w: number };
  /** where the stair's own frame sits in the level */
  ox: number;
  oz: number;
  private stubs: Stubs;
  private m: Mats;
  private colKey: string;
  private built = false;
  constructor(public desc: Extract<LevelDesc, { kind: 'interior' }>, bounds: { x0: number; z0: number }, H: number, wallT: number) {
    this.d = dims({ ...SPECS.house, H, risers: Math.round(H / 0.185) });
    this.H = H;
    this.floor = desc.floor;
    this.floors = desc.floors;
    this.top = desc.floors - 1;
    this.key = `house|${desc.seed}`;
    this.colKey = `${this.key}|${H.toFixed(2)}`;
    this.ox = bounds.x0 + 1.05;
    this.oz = bounds.z0 - wallT / 2 - this.d.Ld - T;
    this.door = { x: this.ox, z: bounds.z0, w: 1.0 };
    this.m = mats('house', desc.seed);
    this.stubs = new Stubs(this.floor);
    this.well.name = 'stairwell';
    this.well.position.set(this.ox, 0, this.oz);
  }
  /** build the column (in slices) into the well group */
  *build() {
    const d = this.d, H = d.H, f = this.floor;
    const col = yield* columnFor(this.colKey, d, this.m, this.spec, false);
    this.built = true;
    const segYs: number[] = [];
    for (let j = 0; j < this.top; j++) segYs.push((j - f) * H);
    instanced(col.segment, segYs, this.well);
    instanced(col.base, [-f * H], this.well);
    instanced(col.cap, [(this.top - f) * H], this.well);
    this.stubs.ys = [...segYs, (this.top - f) * H];
    this.stubs.list = instanced(col.stub, this.stubs.ys, this.well);
    this.stubs.apply();
  }
  /** colliders in level coordinates */
  colliders(): Rect[] {
    return stairRects(this.d, this.spec, this.floor === 0, this.floor === this.top, false).map((r) => ({ minX: r.minX + this.ox, maxX: r.maxX + this.ox, minZ: r.minZ + this.oz, maxZ: r.maxZ + this.oz }));
  }
  ground(x: number, z: number, y: number) {
    return groundAt(this.d, x - this.ox, z - this.oz, y);
  }
  nearStair(p: THREE.Vector3) {
    const x = p.x - this.ox, z = p.z - this.oz, d = this.d;
    return x > -d.SW / 2 - 1.5 && x < d.SW / 2 + 1.5 && z > d.zBack - 0.5 && z < d.Ld + 3.5;
  }
  neighbour(dir: number) {
    const f = this.floor + dir;
    return f < 0 || f > this.top ? null : this.at(f);
  }
  at(f: number): LevelDesc {
    return { ...this.desc, floor: f };
  }
  setStub(dir: number, hidden: boolean) {
    this.stubs.set(dir, hidden);
  }
  prefetch(p: THREE.Vector3): LevelDesc[] {
    const out: LevelDesc[] = [];
    if (this.nearStair(p)) for (const dir of [1, -1]) {
      const n = this.neighbour(dir);
      if (n) out.push(n);
    }
    return out;
  }
  dispose() {
    if (!this.built) return;
    this.built = false;
    releaseColumn(this.colKey);
  }
}

/** does this interior get a stair core (a house of more than one floor)? */
export function wantsHouseCore(desc: Extract<LevelDesc, { kind: 'interior' }>) {
  return desc.style === 'house' && desc.floors > 1 && !desc.shop;
}
/** a house with more than one floor gets a stair core behind its back wall (null otherwise) */
export function houseCore(desc: Extract<LevelDesc, { kind: 'interior' }>, bounds: { x0: number; z0: number }, H: number, wallT: number) {
  return wantsHouseCore(desc) ? new HouseCore(desc, bounds, H, wallT) : null;
}

// ---------------------------------------------------------------- frames on walls

/** a frame on a wall: origin on the wall face (floor level), local +z into the hall, x along the wall */
export interface Fr {
  x: number;
  z: number;
  r: number;
}
export function toWorld(f: Fr, lx: number, lz: number): [number, number] {
  const c = Math.cos(f.r), s = Math.sin(f.r);
  return [f.x + lx * c + lz * s, f.z - lx * s + lz * c];
}
function rectLocal(f: Fr, x0: number, x1: number, z0: number, z1: number): Rect {
  const a = toWorld(f, x0, z0), b = toWorld(f, x1, z1);
  return { minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]), minZ: Math.min(a[1], b[1]), maxZ: Math.max(a[1], b[1]) };
}

export interface LiftFront {
  frame: Fr;
  /** 0 closed .. 1 open (set by src/vertical.ts) */
  open: number;
  left: THREE.Object3D;
  right: THREE.Object3D;
  needle: THREE.Object3D | null;
  call: Portal;
}

interface Hole {
  a: number;
  b: number;
  top: number;
  /** a closed door: solid for collisions */
  solid: boolean;
}

// ---------------------------------------------------------------- the level

const OUTDOOR: Env = {
  skyTop: '#5d8cc4', skyBottom: '#e9dcc8', stars: false, fog: '#aab6c2', fogNear: 110, fogFar: 520,
  sun: { color: '#ffd9a8', intensity: 4.2, elev: 30, azim: 235 }, hemi: { sky: '#cfdcec', ground: '#5a5046', intensity: 0.9 },
  ambient: 0.05, envIntensity: 0.55, exposure: 0.62, physicalSky: true,
};

/** portals that run an action (call the lift, press a button) instead of going somewhere */
export const portalActions = new WeakMap<Portal, () => void>();

export class FloorLevel implements Level, VCore {
  name: string;
  group = new THREE.Group();
  spawn = { pos: new THREE.Vector3(), yaw: 0 };
  env: Env;
  doorway?: Level['doorway'];
  staging?: Iterator<unknown>;
  readonly type: BType;
  readonly spec: Spec;
  readonly d: Dims;
  readonly floor: number;
  readonly floors: number;
  readonly roof: boolean;
  /** the stair column (hidden while this level is shown as a neighbour through the stairwell) */
  well = new THREE.Group();
  lifts: LiftFront[] = [];
  /** extra portals src/vertical.ts adds (the cab panel while the car is here) */
  extra: Portal[] = [];
  /** set by src/vertical.ts while riding to a floor: prebuilt by seamless.ts */
  rideTarget: LevelDesc | null = null;
  /** apartment / office doors on this floor (labels) */
  units: string[] = [];
  private stubs: THREE.InstancedMesh[] = [];
  private stubYs: number[] = [];
  private stubHidden = new Set<number>();
  private cols: Rect[] = [];
  private ports: Portal[] = [];
  private m: Mats;
  private rng: Rng;
  private colKey: string;
  private kit = new Kit();
  private lights: THREE.PointLight[] = [];

  constructor(public desc: FloorDesc, opts: { staged?: boolean } = {}) {
    this.type = (SPECS[desc.type as BType] ? desc.type : 'walkup') as BType;
    this.spec = SPECS[this.type];
    // the lobby's style (src/rooms/lobbies.ts) sets the lobby room's depth and width for every floor of the
    // building (they only shape floor 0, but the plan must agree on every floor)
    this.lobbyStyle = this.type === 'walkup' ? null : lobbyStyleFor(this.type, desc.seed);
    const ls = this.lobbyStyle;
    this.d = dims(ls ? { ...this.spec, lobbyL: this.spec.lobbyL * ls.depth, lobbyW: this.spec.lobbyW * ls.width } : this.spec);
    this.floor = desc.floor;
    this.floors = desc.floors;
    this.roof = desc.floor >= desc.floors;
    this.name = floorName(desc);
    this.rng = new Rng(hashN(desc.seed, desc.floor, 31));
    this.m = mats(this.type, desc.seed);
    this.colKey = `${this.type}|${desc.seed}`;
    this.env = this.roof
      ? OUTDOOR
      : {
          skyTop: '#1a1612', skyBottom: '#2a241e', stars: false, fog: null, fogNear: 0, fogFar: 0, sun: null,
          hemi: { sky: '#fff1dc', ground: '#6a5a48', intensity: this.type === 'office' ? 0.5 : 0.36 }, ambient: 0.05, envIntensity: 0.35, exposure: 1.0,
        };
    this.group.name = `floor:${this.name}`;
    this.well.name = 'stairwell';
    this.group.add(this.well);
    this.staging = timed(this.generate(), this.slices);
    if (!opts.staged) finishBuilding(this);
  }
  /** ms of each construction slice (for perf checks) */
  slices: number[] = [];

  colliders() {
    // the lift door opening is blocked unless its doors are (nearly) open
    const out = this.cols.slice();
    for (const l of this.lifts) if (l.open < 0.85) out.push(rectLocal(l.frame, -LIFT.door / 2, LIFT.door / 2, -0.14, -0.04));
    return out;
  }
  portals() {
    return this.extra.length ? this.ports.concat(this.extra) : this.ports;
  }
  /** the lobby's style, staff posts and what was placed (floor 0 of prewar / office / loft buildings) */
  lobbyStyle: LobbyStyle | null = null;
  lobbyBuilt: LobbyBuilt | null = null;
  private staff: Person[] = [];
  private staffWanted = false;
  update(dt = 0, player?: THREE.Vector3) {
    if (this.staffWanted && !this.staff.length && this.lobbyBuilt) this.hireStaff();
    for (const p of this.staff) p.update(dt);
    // the lobby's sculptures stream in (showcase slots) as you come near
    if (player && this.lobbyBuilt?.plinths.length) updateShowcases(player);
  }
  /** doormen, guards and a visitor: people-system bodies, idling at their posts (loaded on first view) */
  private hireStaff() {
    this.staffWanted = false;
    const posts = this.lobbyBuilt!.staff;
    loadPeopleAssets().then((assets) => {
      if (this.group.userData.disposed) return;
      posts.forEach((post: StaffPost, i: number) => {
        const r = new Rng(hashN(this.desc.seed, i, 31));
        const uni: Uniform | undefined = post.role === 'doorman' ? { top: '#1a2436', bottom: '#14161c', cap: '#1a2436', long: true } : post.role === 'guard' ? { top: '#22262c', bottom: '#16181c' } : undefined;
        const p = new Person(assets, r, post.role === 'visitor' ? (r.chance(0.5) ? 'male' : 'female') : 'male', uni);
        p.setActivity(post.role === 'visitor' && r.chance(0.6) ? 'phone' : 'idle', r.range(0, 4));
        p.root.position.set(post.x, 0, post.z);
        p.root.rotation.y = post.yaw;
        this.group.add(p.root);
        this.staff.push(p);
      });
    }, () => {});
  }
  dispose() {
    disposeTree(this.group);
    if (this.hasColumn) releaseColumn(this.colKey);
  }
  private hasColumn = false;

  /** the walkable height near y at (x, z) */
  ground(x: number, z: number, y: number) {
    return groundAt(this.d, x, z, y);
  }
  /** src/vertical.ts: this level's stair and lifts */
  get vcore(): VCore {
    return this;
  }
  get H() {
    return this.d.H;
  }
  get top() {
    return this.floors;
  }
  get key() {
    return this.colKey;
  }
  get speed() {
    return this.spec.speed;
  }
  at(f: number): LevelDesc {
    return { ...this.desc, floor: f };
  }
  /** on the stair or close to its landing */
  nearStair(p: THREE.Vector3, margin = 3.5) {
    const d = this.d;
    return p.x > -d.SW / 2 - 1.5 && p.x < d.SW / 2 + 1.5 && p.z > d.zBack - 0.5 && p.z < d.Ld + margin;
  }
  /** the floor `dir` storeys away, or null past the bottom / roof */
  neighbour(dir: number): FloorDesc | null {
    const f = this.floor + dir;
    if (f < 0 || f > this.floors) return null;
    return { ...this.desc, floor: f };
  }
  /** seamless.ts: levels to prebuild now (the floors above and below near the stair, the lift's destination) */
  prefetch(p: THREE.Vector3): LevelDesc[] {
    const out: LevelDesc[] = [];
    if (this.nearStair(p)) for (const dir of [1, -1]) {
      const n = this.neighbour(dir);
      if (n) out.push(n);
    }
    if (this.rideTarget) out.push(this.rideTarget);
    return out;
  }
  /** hide the far-floor stub of hall at the floor `dir` storeys away (when the real one is shown) */
  setStub(dir: number, hidden: boolean) {
    const j = this.floor + dir;
    if (hidden === this.stubHidden.has(j)) return;
    if (hidden) this.stubHidden.add(j);
    else this.stubHidden.delete(j);
    this.applyStubs();
  }
  private applyStubs() {
    const m = new THREE.Matrix4();
    for (const im of this.stubs) {
      this.stubYs.forEach((y, i) => {
        const j = i;
        if (this.stubHidden.has(j) || j === this.floor) m.makeScale(0, 0, 0);
        else m.makeTranslation(0, y, 0);
        im.setMatrixAt(i, m);
      });
      im.instanceMatrix.needsUpdate = true;
    }
  }

  // ------------------------------------------------------------ construction

  private *generate() {
    const d = this.d, s = this.spec, f = this.floor, H = d.H;
    // 1. the stair column: one instance per storey, relative to this floor
    const col = yield* columnFor(this.colKey, d, this.m, s);
    this.hasColumn = true;
    const segYs: number[] = [];
    for (let j = 0; j < this.floors; j++) segYs.push((j - f) * H);
    instanced(col.segment, segYs, this.well);
    instanced(col.base, [-f * H], this.well);
    instanced(col.cap, [(this.floors - f) * H], this.well);
    this.stubYs = segYs;
    this.stubs = instanced(col.stub, segYs, this.well);
    this.applyStubs();
    this.numbers();
    this.stairColliders();
    yield;

    // 2. lights: the same rig on every floor (4 point lights) so switching floors never changes
    // the scene's light count (which would recompile every shader)
    const rig: [number, number, number, number, number][] = [
      [0, H / 2 + 1.7, -d.Lf - d.Md / 2, 7 + H, this.roof ? 4 : 7],
      [0, -H / 2 + 1.7, -d.Lf - d.Md / 2, 6 + H, f > 0 ? 3 : 0],
      [0, d.Hc - 0.4, d.Ld + s.hallL * 0.3, 9, this.roof ? 0 : 9],
      [0, d.Hc - 0.4, this.floor === 0 ? d.zH1 + s.lobbyL / 2 : d.Ld + s.hallL * 0.8, this.floor === 0 ? 14 : 9, this.roof ? 0 : this.floor === 0 ? (this.type === 'office' ? 9 : 12) : 7],
    ];
    for (const [x, y, z, dist, i] of rig) {
      const l = new THREE.PointLight(this.type === 'office' ? '#f4f6ff' : '#ffdcb0', i, dist, 2);
      l.position.set(x, y, z);
      this.group.add(l);
      this.lights.push(l);
    }
    yield;

    if (this.roof) {
      yield* this.roofTop();
    } else {
      yield* this.hall();
      if (f === 0) {
        // merge the hall now, the lobby in its own slice
        this.flush('hall');
        yield;
        yield* this.lobby();
      }
    }
    yield;
    this.flush(this.roof ? 'roof' : f === 0 ? 'lobby' : 'hall');
  }
  private flush(name: string) {
    const g = new THREE.Group();
    g.name = name;
    this.kit.finish(g);
    this.group.add(g);
    this.kit = new Kit();
  }

  /** stencilled (or plaque) floor numbers at every landing, merged into one mesh */
  private numbers() {
    const d = this.d, k = new Kit();
    const steel = this.m.steel;
    for (let j = 0; j <= this.floors; j++) {
      const label = floorLabel(this.type, j, this.floors);
      const y = (j - this.floor) * d.H;
      const h = steel ? 0.42 : 0.12, w = h * 0.62;
      // on the side wall of the landing, facing in
      k.at(-d.SW / 2 + 0.005, y + (steel ? 1.55 : 1.62), d.Ld * 0.55, Math.PI / 2, () => {
        if (!steel) k.box(M.enamel('#f2efe6'), label.length * w + 0.06, h + 0.05, 0.006, 0, -h / 2 - 0.025, -0.003);
        [...label].forEach((ch, i) => k.add(glyphQuad(ch, w, h), this.m.glyph, new THREE.Matrix4().makeTranslation((i - (label.length - 1) / 2) * w * 0.9, 0, 0.004), 'keep'));
      });
    }
    k.finish(this.well, false);
  }

  private stairColliders() {
    this.cols.push(...stairRects(this.d, this.spec, this.floor === 0, this.roof, true));
  }

  /** a wall along a line with holes (doors, lifts): geometry, trim and colliders */
  private wallLine(axis: 'x' | 'z', c: number, a0: number, a1: number, out: 1 | -1, h: number, holes: Hole[], wallM: THREE.Material) {
    const k = this.kit, m = this.m;
    holes.sort((p, q) => p.a - q.a);
    const segs: [number, number][] = [];
    let a = a0;
    for (const o of holes) {
      if (o.a > a) segs.push([a, o.a]);
      a = Math.max(a, o.b);
    }
    if (a < a1) segs.push([a, a1]);
    const put = (mm: THREE.Material, s0: number, s1: number, y: number, hh: number, inset: number, thick: number) => {
      const len = s1 - s0, mid = (s0 + s1) / 2;
      const off = c + out * (inset + thick / 2);
      if (axis === 'x') k.box(mm, thick, hh, len, off, y, mid);
      else k.box(mm, len, hh, thick, mid, y, off);
    };
    for (const [s0, s1] of segs) {
      put(wallM, s0, s1, 0, h, 0, T);
      // wainscot / baseboard / picture rail on the hall face
      if (m.wainscot && s1 - s0 > 0.05) {
        put(m.wainscot, s0, s1, 0, this.type === 'walkup' ? 1.05 : 1.15, -0.012, 0.012);
        put(m.trim, s0, s1, this.type === 'walkup' ? 1.05 : 1.15, 0.05, -0.022, 0.022);
      }
      put(m.trim, s0, s1, 0, 0.12, -0.016, 0.016);
      if (this.type === 'prewar') put(m.trim, s0, s1, h - 0.45, 0.03, -0.015, 0.015);
      const r: Rect = axis === 'x' ? { minX: Math.min(c, c + out * T), maxX: Math.max(c, c + out * T), minZ: s0, maxZ: s1 } : { minX: s0, maxX: s1, minZ: Math.min(c, c + out * T), maxZ: Math.max(c, c + out * T) };
      this.cols.push(r);
    }
    for (const o of holes) {
      if (o.top < h) put(wallM, o.a, o.b, o.top, h - o.top, 0, T);
      if (o.solid) this.cols.push(axis === 'x' ? { minX: Math.min(c, c + out * T), maxX: Math.max(c, c + out * T), minZ: o.a, maxZ: o.b } : { minX: o.a, maxX: o.b, minZ: Math.min(c, c + out * T), maxZ: Math.max(c, c + out * T) });
    }
  }

  /** the frame of a point on a wall line: origin on the hall face, +z into the hall */
  private frameOn(axis: 'x' | 'z', c: number, t: number, out: 1 | -1): Fr {
    // inward normal: -out along the axis
    const nx = axis === 'x' ? -out : 0, nz = axis === 'z' ? -out : 0;
    return { x: axis === 'x' ? c : t, z: axis === 'z' ? c : t, r: Math.atan2(nx, nz) };
  }

  private *hall() {
    const d = this.d, s = this.spec, f = this.floor, k = this.kit, m = this.m, r = this.rng;
    const hw = d.hw, z0 = d.Ld, z1 = d.zH1;
    // floor and ceiling
    k.box(m.hallFloor, hw, 0.02, z1 - z0, 0, -0.02, (z0 + z1) / 2);
    if (this.type === 'prewar' && f > 0) k.box(M.carpet(r.pick(['#5a2a2a', '#2a3a5a', '#3a4a3a', '#6a4a2a'])), 1.0, 0.012, z1 - z0 - 0.6, 0, 0, (z0 + z1) / 2);
    k.box(m.ceiling, hw, 0.02, z1 - z0, 0, d.Hc, (z0 + z1) / 2);
    if (s.enclosed) {
      // drop ceiling below the slab: a band over the stair door wall
      k.box(m.hallWall, Math.max(hw, d.SW + 2 * T), d.H - d.Hc, 0.05, 0, d.Hc, z0 + T + 0.025);
    }
    // ceiling fixtures
    k.unshadowed(() => {
      for (let z = z0 + 1.6; z < z1 - 0.8; z += 3.2) {
        if (m.steel) k.box(M.troffer(), 0.6, 0.02, 1.2, 0, d.Hc - 0.02, z);
        else {
          k.cyl(M.brass(), 0.06, 0.06, 0.04, 0, d.Hc - 0.04, z, 10);
          k.sphere(M.diffuser(), 0.16, 0, d.Hc - 0.18, z, 0.75);
        }
      }
    });
    yield;

    // where the doors go: lifts first, then units along both walls, then the far end
    const lifts = s.lifts.filter(() => true);
    const holes: Record<string, Hole[]> = { '1': [], '-1': [], end: [] };
    const zStart = s.enclosed || hw < d.SW ? z0 + T : z0;
    const slots: { side: 1 | -1 | 0; t: number }[] = [];
    for (const side of [-1, 1] as const) {
      let z = zStart + 0.75;
      while (z < z1 - 0.65) {
        if (lifts.some((l) => l.side === side && Math.abs(z0 + l.at - z) < 1.75) || (f === 0 && z > z1 - 1.4)) {
          z += 0.2;
          continue;
        }
        slots.push({ side, t: z });
        z += 2.5;
      }
    }
    if (f > 0) slots.push({ side: 0, t: 0 });
    // alternate sides from the stair outwards
    slots.sort((a, b) => (a.side === 0 ? 99 : a.t) - (b.side === 0 ? 99 : b.t));
    const nUnits = Math.min(slots.length, f === 0 ? s.lobbyUnits : s.units);
    const chosen = slots.slice(0, nUnits);
    chosen.sort((a, b) => a.side - b.side || a.t - b.t);
    const letters = 'ABCDEFGHJK';
    chosen.forEach((sl, i) => {
      const label = this.unitLabel(i, letters);
      this.units.push(label);
      if (sl.side === 0) {
        holes.end.push({ a: -DW / 2, b: DW / 2, top: DH, solid: true });
        this.unitDoor(this.frameOn('z', z1, 0, 1), label, i);
      } else {
        const c = sl.side * hw / 2;
        holes[String(sl.side)].push({ a: sl.t - DW / 2, b: sl.t + DW / 2, top: DH, solid: true });
        this.unitDoor(this.frameOn('x', c, sl.t, sl.side), label, i);
      }
    });
    yield;
    lifts.forEach((l, i) => {
      const t = z0 + l.at;
      holes[String(l.side)].push({ a: t - LIFT.door / 2, b: t + LIFT.door / 2, top: 2.2, solid: false });
      this.liftFront(this.frameOn('x', l.side * hw / 2, t, l.side), i);
    });
    // walls (the hall's sides from the stair to the far end / lobby)
    for (const side of [-1, 1] as const) this.wallLine('x', side * hw / 2, zStart, z1, side, d.Hc, holes[String(side)], m.hallWall);
    if (f > 0) this.wallLine('z', z1, -hw / 2 - T, hw / 2 + T, 1, d.Hc, holes.end, m.hallWall);
    if (s.enclosed && hw > d.SW + 2 * T) {
      // the hall's stair-end wall beside the stair enclosure
      for (const sx of [-1, 1]) {
        const a = d.SW / 2 + T, b = hw / 2;
        k.box(m.hallWall, b - a, d.Hc, T, sx * (a + b) / 2, 0, z0 + T / 2);
        this.cols.push({ minX: Math.min(sx * a, sx * b), maxX: Math.max(sx * a, sx * b), minZ: z0, maxZ: z0 + T });
      }
    }
    yield;
    this.hallClutter(chosen, hw);
  }

  private unitLabel(i: number, letters: string) {
    const f = this.floor;
    if (this.type === 'office') return `Suite ${(f + 1) * 100 + i * 10}`;
    if (this.type === 'loft') return `Loft ${f + 1}${letters[i]}`;
    return `${f + 1}${letters[i]}`;
  }

  private unitDoor(fr: Fr, label: string, i: number) {
    const k = this.kit, m = this.m;
    const office = this.type === 'office' || this.type === 'loft';
    k.at(fr.x, 0, fr.z, fr.r, () => {
      k.at(-DW / 2, 0, -0.06, 0, () => F.doorLeaf(k, DW, DH, m.door));
      for (const sx of [-1, 1]) k.box(m.trim, 0.08, DH + 0.04, 0.025, sx * (DW / 2 + 0.04), 0, 0.0125);
      k.box(m.trim, DW + 0.24, 0.09, 0.025, 0, DH, 0.0125);
      // threshold
      k.box(M.marble('#d8d2c6'), DW, 0.012, T, 0, 0, -T / 2);
      if (!office) {
        k.cyl(M.brass(), 0.012, 0.012, 0.02, 0, 1.52, -0.02, 8);
        if (this.rng.chance(0.6)) k.box(M.fabric(this.rng.pick(['#5a4a3a', '#3a3a3a', '#6a3a2a', '#2a3a4a'])), 0.75, 0.012, 0.45, 0, 0, 0.3);
      }
    });
    // the number plate on the door, or a suite sign beside it
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(office ? 0.42 : 0.16, office ? 0.11 : 0.05), new THREE.MeshStandardMaterial({ map: signTex(label, office ? '#2a2c30' : '#b8925a', office ? '#f2f2f0' : '#2a1d10'), roughness: 0.4, metalness: office ? 0 : 0.6 }));
    plate.userData.owned = true;
    (plate.material as THREE.Material).userData.owned = true; // its own material (the label texture is memoised)
    const [px, pz] = toWorld(fr, office ? DW / 2 + 0.38 : 0, office ? 0.012 : -0.012);
    plate.position.set(px, office ? 1.55 : 1.64, pz);
    plate.rotation.y = fr.r;
    this.group.add(plate);
    // the portal: the apartment / office behind it, prebuilt by seamless.ts as you face it
    const [dx, dz] = toWorld(fr, 0, 0);
    const [ix, iz] = toWorld(fr, 0, 0.9);
    const unitSeed = hashN(this.desc.seed, this.floor, i, 77);
    const style = this.rng.pick(this.spec.unitStyles);
    // office suites: a type per building, floor, unit and district (src/rooms/office.ts)
    const suite = style === 'office' ? officeTypeFor(this.desc.seed, this.type, this.desc.district, this.floor, i) : null;
    const box = new THREE.Box3().setFromPoints([new THREE.Vector3(...xyz(toWorld(fr, -0.7, -0.3), 0)), new THREE.Vector3(...xyz(toWorld(fr, 0.7, 0.6), 2.4))]);
    this.ports.push({
      box,
      label: office ? `Enter ${label}` : `Go into apartment ${label}`,
      sub: suite ? OFFICE_NAMES[suite] : style === 'workshop' ? 'a loft workshop' : `${this.rng.int(1, 3)} bedrooms`,
      target: { kind: 'interior', seed: unitSeed, name: `${this.desc.name} · ${label}`, style, floor: 0, floors: 1, biome: 'town', ...(suite ? { office: suite } : {}) },
      returnPos: new THREE.Vector3(ix, 0, iz),
      returnYaw: fr.r + Math.PI,
      door: { pos: new THREE.Vector3(dx, 0, dz), yaw: fr.r },
    });
  }

  private liftFront(fr: Fr, i: number) {
    const k = this.kit, m = this.m, w = LIFT.door;
    const prewar = this.type === 'prewar';
    // surround
    k.at(fr.x, 0, fr.z, fr.r, () => {
      const sw = prewar ? 0.16 : 0.08;
      for (const sx of [-1, 1]) k.box(m.surround, sw, 2.2 + sw, 0.03, sx * (w / 2 + sw / 2), 0, 0.015);
      k.box(m.surround, w + 2 * sw, sw, 0.03, 0, 2.2, 0.015);
      // sill and the shaft's dark inside above the doors
      k.box(M.steel(), w, 0.012, LIFT.depth, 0, 0, -LIFT.depth / 2);
      // call plate with two buttons
      k.box(m.surround, 0.1, 0.22, 0.012, w / 2 + 0.28, 1.0, 0.006);
      k.unshadowed(() => {
        k.cyl(M.bulb(), 0.018, 0.018, 0.01, w / 2 + 0.28, 1.15, 0.012, 10);
        k.cyl(M.porcelain(), 0.018, 0.018, 0.01, w / 2 + 0.28, 1.06, 0.012, 10);
      });
    });
    // sliding hall doors (separate meshes, animated)
    const leafGeo = new THREE.BoxGeometry(w / 2 + 0.02, 2.19, 0.035);
    leafGeo.translate(0, 2.19 / 2, 0);
    const mk = () => {
      const mesh = new THREE.Mesh(leafGeo, m.liftDoor);
      mesh.userData.owned = true;
      mesh.castShadow = mesh.receiveShadow = true;
      return mesh;
    };
    const holder = new THREE.Group();
    holder.position.set(fr.x, 0, fr.z);
    holder.rotation.y = fr.r;
    const left = mk(), right = mk();
    left.position.set(-w / 4, 0, -0.07);
    right.position.set(w / 4, 0, -0.07);
    holder.add(left, right);
    // indicator: a dial in pre-war lobbies, a lit number elsewhere
    let needle: THREE.Object3D | null = null;
    if (prewar && this.floor === 0) {
      const dial = new THREE.Mesh(new THREE.CircleGeometry(0.3, 24, 0, Math.PI), new THREE.MeshStandardMaterial({ map: this.dialTex(), roughness: 0.35, metalness: 0.5 }));
      dial.userData.owned = true;
      dial.position.set(0, 2.42, 0.035);
      holder.add(dial);
      const n = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.25, 0.006), M.black());
      n.geometry.translate(0, 0.125, 0);
      n.userData.owned = true;
      n.position.set(0, 2.44, 0.045);
      holder.add(n);
      needle = n;
    } else {
      const ind = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.11), liftDisplay.mat);
      ind.userData.owned = true;
      ind.position.set(0, 2.4, 0.034);
      holder.add(ind);
    }
    this.group.add(holder);
    // the call button (a portal whose action src/vertical.ts sets)
    const [bx, bz] = toWorld(fr, w / 2 + 0.28, 0.1);
    const box = new THREE.Box3(new THREE.Vector3(bx - 0.35, 0.7, bz - 0.35), new THREE.Vector3(bx + 0.35, 1.6, bz + 0.35));
    const call: Portal = { box, label: 'Call the elevator', sub: this.spec.lifts.length > 1 ? `car ${i + 1}` : 'press E', target: 'inspect' };
    this.ports.push(call);
    this.lifts.push({ frame: fr, open: 0, left, right, needle, call });
    // the shaft: walls around the car (colliders; the car itself is drawn by src/vertical.ts)
    const W = LIFT.w / 2, D0 = -LIFT.depth, D1 = -LIFT.depth - LIFT.d;
    this.cols.push(rectLocal(fr, -W - T, -W, D1 - T, D0));
    this.cols.push(rectLocal(fr, W, W + T, D1 - T, D0));
    this.cols.push(rectLocal(fr, -W - T, W + T, D1 - T, D1));
    this.cols.push(rectLocal(fr, -W - T, -w / 2, D0, 0));
    this.cols.push(rectLocal(fr, w / 2, W + T, D0, 0));
  }

  private dialTex() {
    return cached(`dial:${this.floors}`, () => {
      const [c, g] = canvas(256, 128);
      g.fillStyle = '#b8925a';
      g.fillRect(0, 0, 256, 128);
      g.fillStyle = '#efe6cc';
      g.beginPath();
      g.arc(128, 128, 112, Math.PI, 0);
      g.fill();
      g.fillStyle = '#2a1d10';
      g.font = 'bold 15px Georgia, serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      const n = Math.min(this.floors, 16);
      for (let i = 0; i < n; i++) {
        const fl = Math.round((i / Math.max(1, n - 1)) * (this.floors - 1));
        const a = Math.PI + (Math.PI * 0.1) + (i / Math.max(1, n - 1)) * Math.PI * 0.8;
        g.fillText(floorLabel(this.type, fl, this.floors), 128 + Math.cos(a) * 92, 128 + Math.sin(a) * 92);
      }
      return canvasTex(c);
    });
  }

  /** what neighbours leave in the hall: strollers, plants, umbrellas, bikes, a shoe rack */
  private hallClutter(units: { side: 1 | -1 | 0; t: number }[], hw: number) {
    const k = this.kit, r = this.rng;
    if (this.type === 'office') {
      // a water cooler / a bench and a plant at the far end
      k.at(hw / 2 - 0.35, 0, this.d.zH1 - 0.5, 0, () => F.plant(k, r, 1.4));
      return;
    }
    for (const u of units) {
      if (u.side === 0 || !r.chance(0.45)) continue;
      const x = u.side * (hw / 2 - 0.25), z = u.t + (r.chance(0.5) ? 0.8 : -0.8);
      const what = r.int(0, 3);
      if (what === 0) k.at(x, 0, z, 0, () => F.plant(k, r, r.range(0.6, 1.1), true));
      else if (what === 1) {
        // umbrella stand
        k.cyl(M.enamel(r.pick(['#2a3a4a', '#7a2a2a', '#d8d0c0'])), 0.11, 0.1, 0.5, x, 0, z, 12);
        k.rod(M.black(), 0.012, 0.7, x, 0.75, z, 'z', 6);
      } else if (what === 2) {
        // shoes on a little rack
        k.box(M.oak('#b08a60'), 0.6, 0.3, 0.28, x, 0, z);
        for (let i = 0; i < 3; i++) k.box(M.leather(r.pick(['#2a1a10', '#5a3a20', '#1a1a1a', '#c9b090'])), 0.1, 0.08, 0.26, x - 0.18 + i * 0.18, 0.3, z);
      } else {
        // a folded stroller against the wall
        k.boxM(M.fabric(r.pick(['#2a2a2a', '#3a4a5a', '#5a2a3a'])), 0.35, 1.0, 0.18, x, 0.5, z, new THREE.Euler(0.15, 0, 0));
        for (const dz of [-0.12, 0.12]) k.cyl(M.black(), 0.08, 0.08, 0.03, x, 0, z + dz, 10);
      }
    }
    if (this.type === 'walkup' || this.type === 'prewar') k.at(-hw / 2 + 0.1, 0, this.d.zH1 - 0.6, Math.PI / 2, () => F.radiator(k, 0.8));
  }

  // ------------------------------------------------------------ lobby

  private *lobby() {
    const d = this.d, s = this.spec, k = this.kit, m = this.m;
    const z0 = d.zH1, z1 = d.zS, lw = d.lw, hw = d.hw;
    const st = this.lobbyStyle;
    const H = st ? st.H : d.Hc;
    const lobbyWall = st ? st.wall() : m.hallWall;
    k.box(st ? st.floor() : m.lobbyFloor, lw, 0.02, z1 - z0, 0, -0.02, (z0 + z1) / 2);
    k.box(st ? st.ceiling() : m.ceiling, lw, 0.02, z1 - z0, 0, H, (z0 + z1) / 2);
    // walls: sides, the junction with the hall, the street wall with the entrance
    const door = 1.3;
    this.wallLine('x', -lw / 2, z0, z1, -1, H, [], lobbyWall);
    const mailSide = 1;
    this.wallLine('x', lw / 2, z0, z1, 1, H, [], lobbyWall);
    if (lw > hw) {
      for (const sx of [-1, 1] as const) {
        const a = hw / 2, b = lw / 2 + T;
        k.box(lobbyWall, b - a, H, T, sx * (a + b) / 2, 0, z0 - T / 2);
        this.cols.push({ minX: Math.min(sx * a, sx * b), maxX: Math.max(sx * a, sx * b), minZ: z0 - T, maxZ: z0 });
        if (H > d.Hc) k.box(lobbyWall, hw, H - d.Hc, T, 0, d.Hc, z0 - T / 2);
      }
    }
    // the street wall and door in their own group: hidden while the lobby is seen through the
    // building's glass from the street (seamless.ts doorway.hide; the facade is the wall then)
    this.kit = new Kit();
    const fk = this.kit;
    this.wallLine('z', z1, -lw / 2 - T, lw / 2 + T, 1, H, [{ a: -door / 2, b: door / 2, top: 2.5, solid: true }], lobbyWall);
    // the street door (glass in a dark frame), seen from inside
    fk.at(0, 0, z1, Math.PI, () => {
      fk.box(M.black(), door, 0.06, 0.06, 0, 2.44, 0);
      for (const sx of [-1, 1]) fk.box(M.black(), 0.06, 2.5, 0.06, sx * (door / 2 - 0.03), 0, 0);
      fk.box(M.black(), 0.04, 2.44, 0.05, 0, 0, 0);
      fk.box(M.windowGlass(), door - 0.1, 2.3, 0.01, 0, 0.1, 0);
      // [windowview] the street behind the door glass (the real city once captured); in the street
      // wall's group, so it hides with it when the lobby is seen from the street
      fk.box(M.viewPlane(), door + 2.4, 3.2, 0.02, 0, 0, -1.6); // (this frame is turned: -z is outside)
      fk.box(M.brass(), 0.03, 0.3, 0.03, -0.12, 1.0, -0.04);
      fk.box(M.brass(), 0.03, 0.3, 0.03, 0.12, 1.0, -0.04);
    });
    const front = new THREE.Group();
    front.name = 'street-wall';
    fk.finish(front);
    this.group.add(front);
    this.kit = k;
    yield;
    this.doorway = { pos: new THREE.Vector3(0, 0, z1), yaw: 0, hide: [front] };
    this.spawn.pos.set(0, 0, z1 - 1.1);
    this.spawn.yaw = 0;
    this.ports.push({
      box: new THREE.Box3(new THREE.Vector3(-0.8, 0, z1 - 0.7), new THREE.Vector3(0.8, 2.5, z1 + 0.3)),
      label: 'Leave the building',
      target: 'back',
    });

    // mailboxes: a brass (or steel) panel of little doors with slots, one per apartment (offices: none)
    if (this.type !== 'office') {
    const nBox = Math.max(4, Math.min(48, (this.floors - 1) * s.units + s.lobbyUnits));
    const cols = Math.min(nBox, this.type === 'walkup' ? 4 : 8), rows = Math.ceil(nBox / cols);
    const bw = 0.14, bh = 0.32;
    const mx = mailSide * (lw / 2) - mailSide * 0.012, mz = st ? z0 + 0.9 + (cols * bw) / 2 : z1 - 1.2 - (cols * bw) / 2;
    const mailM = this.type === 'loft' ? M.steel() : M.brass();
    k.at(mx, 0, mz, -mailSide * Math.PI / 2, () => {
      const W = cols * bw + 0.08, Hh = rows * bh + 0.08, y0 = 1.65 - Hh;
      k.box(M.black(), W, Hh, 0.02, 0, y0, 0);
      for (let i = 0; i < cols; i++)
        for (let j = 0; j < rows; j++) {
          const x = -W / 2 + 0.04 + (i + 0.5) * bw, y = y0 + 0.04 + j * bh;
          k.box(mailM, bw - 0.01, bh - 0.01, 0.012, x, y + 0.005, 0.012);
          k.box(M.black(), 0.012, 0.09, 0.004, x, y + bh * 0.55, 0.02);
          k.box(M.enamel('#efe8d8'), bw * 0.6, 0.03, 0.004, x, y + bh * 0.3, 0.02);
          k.cyl(M.black(), 0.008, 0.008, 0.004, x, y + 0.06, 0.02, 6);
        }
      if (this.type !== 'office') k.box(mailM, W, 0.18, 0.015, 0, 1.68, 0.01);
    });
    }
    yield;

    if (this.type === 'walkup') {
      // vestibule: a glazed inner door frame halfway down the entry, radiator, a light
      const zv = z1 - 2.2;
      for (const sx of [-1, 1]) k.box(m.trim, 0.1, d.Hc, 0.12, sx * (hw / 2 - 0.05), 0, zv);
      k.box(m.trim, hw, 0.5, 0.12, 0, d.Hc - 0.5, zv);
      k.box(M.glass(), hw - 0.2, 0.4, 0.01, 0, d.Hc - 0.45, zv);
      k.at(-hw / 2 + 0.1, 0, z1 - 3.4, Math.PI / 2, () => F.radiator(k, 0.9));
    } else {
      // the style's furnishing: desk or doorman's podium, art, sculpture, seating, plants, fittings, staff
      this.lobbyBuilt = furnishLobby(st!, { k, group: this.group, cols: this.cols, ports: this.ports, z0, z1, lw, hw, H, seed: this.desc.seed, name: this.desc.name, office: this.type === 'office' || this.type === 'loft' });
      this.staffWanted = true;
    }
    if (this.type === 'office') {
      // turnstiles across the lobby, a directory
      const zt = z0 + 1.6;
      const gate = 0.72;
      const n = 6;
      const x0 = -((n - 1) * (gate + 0.3)) / 2;
      for (let i = 0; i < n; i++) {
        const x = x0 + i * (gate + 0.3);
        k.box(M.steel(), 0.3, 1.0, 1.4, x, 0, zt);
        k.box(M.black(), 0.28, 0.02, 1.3, x, 1.0, zt);
        k.unshadowed(() => k.box(mat('#2aff6a', { emissive: '#2aff6a', ei: 1.5 }), 0.06, 0.01, 0.06, x, 1.02, zt + 0.5));
        if (i < n - 1) k.box(M.glass(), 0.02, 0.7, 0.5, x + 0.15 + gate * 0.25, 0.4, zt);
        this.cols.push({ minX: x - 0.15, maxX: x + 0.15, minZ: zt - 0.7, maxZ: zt + 0.7 });
      }
      // walls either side of the turnstile line
      const xe = x0 + (n - 1) * (gate + 0.3) + 0.15;
      if (lw / 2 > xe + 0.1) {
        for (const sx of [-1, 1]) {
          k.box(M.glass(), lw / 2 - xe, 1.1, 0.02, sx * (xe + lw / 2) / 2, 0, zt);
          this.cols.push({ minX: Math.min(sx * xe, sx * lw / 2), maxX: Math.max(sx * xe, sx * lw / 2), minZ: zt - 0.05, maxZ: zt + 0.05 });
        }
      }
      const dir = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.5), new THREE.MeshStandardMaterial({ map: signTex(this.desc.name.toUpperCase(), '#1a1c20', '#e8e4da'), roughness: 0.4 }));
      dir.userData.owned = true;
      (dir.material as THREE.Material).userData.owned = true; // releases its sign texture (textures.ts cachedUse)
      dir.position.set(lw / 2 - 0.02, 2.2, z1 - 3);
      dir.rotation.y = -Math.PI / 2;
      this.group.add(dir);
    }
  }

  // ------------------------------------------------------------ roof

  private *roofTop() {
    const d = this.d, s = this.spec, k = this.kit, r = this.rng;
    const W = Math.max(s.roofW, d.lw + 1, d.SW + 3);
    const zA = d.zBack - 3.5, zB = d.zS;
    const tar = mat('#5a5652', { rough: 0.95, map: roofTex('#4a4744') });
    // the outside of the bulkhead: stucco / brick, a little proud of the stair walls
    const bm = mat(this.type === 'office' ? '#8a8680' : '#8a5a44', { rough: 0.9 });
    const x0 = -d.SW / 2 - T - 0.03, x1 = d.SW / 2 + T + 0.03, zb = d.zBack - T - 0.03, zf = d.Ld + T + 0.03;
    // tar deck around (not over) the bulkhead
    const deck = (a0: number, a1: number, b0: number, b1: number) => k.box(tar, a1 - a0, 0.02, b1 - b0, (a0 + a1) / 2, -0.02, (b0 + b1) / 2, 0, 'world', [0.25, 0.25]);
    deck(-W / 2, W / 2, zA, zb);
    deck(-W / 2, W / 2, zf, zB);
    deck(-W / 2, x0, zb, zf);
    deck(x1, W / 2, zb, zf);
    k.box(bm, 0.03, 2.9, zf - zb, x0 + 0.015, 0, (zb + zf) / 2);
    k.box(bm, 0.03, 2.9, zf - zb, x1 - 0.015, 0, (zb + zf) / 2);
    k.box(bm, x1 - x0, 2.9, 0.03, 0, 0, zb + 0.015);
    const d0 = d.SW / 2 - 1.0, d1 = d.SW / 2 - 0.1;
    k.box(bm, d0 - x0, 2.9, 0.03, (x0 + d0) / 2, 0, zf - 0.015);
    k.box(bm, x1 - d1, 2.9, 0.03, (x1 + d1) / 2, 0, zf - 0.015);
    k.box(bm, d1 - d0, 0.85, 0.03, (d0 + d1) / 2, 2.05, zf - 0.015);
    yield;
    // parapet with coping
    const pm = mat(this.type === 'office' ? '#9a948a' : '#8c5a44', { rough: 0.9 });
    const cope = mat('#b8b0a2', { rough: 0.7 });
    const runs: [number, number, number, number][] = [
      [-W / 2 - 0.3, -W / 2, zA, zB],
      [W / 2, W / 2 + 0.3, zA, zB],
      [-W / 2 - 0.3, W / 2 + 0.3, zA - 0.3, zA],
      [-W / 2 - 0.3, W / 2 + 0.3, zB, zB + 0.3],
    ];
    for (const [a0, a1, b0, b1] of runs) {
      k.box(pm, a1 - a0, 1.0, b1 - b0, (a0 + a1) / 2, 0, (b0 + b1) / 2);
      k.box(cope, a1 - a0 + 0.08, 0.06, b1 - b0 + 0.08, (a0 + a1) / 2, 1.0, (b0 + b1) / 2);
      this.cols.push({ minX: a0, maxX: a1, minZ: b0, maxZ: b1 });
    }
    // the bulkhead's outside walls collide as well
    this.cols.push({ minX: x0, maxX: x1, minZ: zb, maxZ: d.zBack - T });
    this.cols.push({ minX: x0, maxX: -d.SW / 2 - T, minZ: zb, maxZ: zf });
    this.cols.push({ minX: d.SW / 2 + T, maxX: x1, minZ: zb, maxZ: zf });
    // elevator machine room over the shafts
    if (s.lifts.length) {
      const sides = [...new Set(s.lifts.map((l) => l.side))];
      for (const side of sides) {
        const ats = s.lifts.filter((l) => l.side === side).map((l) => d.Ld + l.at);
        const za = Math.min(...ats) - 1.2, zb2 = Math.max(...ats) + 1.2;
        const xa = side * d.hw / 2, xb = side * (d.hw / 2 + LIFT.depth + LIFT.d + T + 0.4);
        k.box(bm, Math.abs(xb - xa), 3.4, zb2 - za, (xa + xb) / 2, 0, (za + zb2) / 2);
        k.box(cope, Math.abs(xb - xa) + 0.1, 0.08, zb2 - za + 0.1, (xa + xb) / 2, 3.4, (za + zb2) / 2);
        this.cols.push({ minX: Math.min(xa, xb), maxX: Math.max(xa, xb), minZ: za, maxZ: zb2 });
      }
    }
    yield;
    // water tower on a steel stand (wooden tank, hoops, conical roof)
    if ((this.type === 'walkup' || this.type === 'prewar' || this.type === 'loft') && this.floors >= 5) {
      const tx = this.type === 'walkup' ? 0 : -W / 4, tz = this.type === 'walkup' ? d.Ld + (zB - d.Ld) * 0.62 : (zA + d.zBack) / 2 + 1.5;
      const R = this.type === 'walkup' ? 1.6 : 2.3, legH = 3.2, th = R * 2.1;
      const steel = mat('#2c2c2e', { rough: 0.6, metal: 0.4 });
      const wood = M.pine('#8a6a4a');
      for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        k.box(steel, 0.18, legH, 0.18, tx + lx * R * 0.72, 0, tz + lz * R * 0.72);
        this.cols.push({ minX: tx + lx * R * 0.72 - 0.1, maxX: tx + lx * R * 0.72 + 0.1, minZ: tz + lz * R * 0.72 - 0.1, maxZ: tz + lz * R * 0.72 + 0.1 });
      }
      for (const yy of [1.2, legH - 0.1]) {
        k.box(steel, R * 1.6, 0.1, 0.1, tx, yy, tz - R * 0.72);
        k.box(steel, R * 1.6, 0.1, 0.1, tx, yy, tz + R * 0.72);
        k.box(steel, 0.1, 0.1, R * 1.6, tx - R * 0.72, yy, tz);
        k.box(steel, 0.1, 0.1, R * 1.6, tx + R * 0.72, yy, tz);
      }
      k.box(wood, R * 2, 0.15, R * 2, tx, legH, tz);
      k.cyl(wood, R, R * 1.03, th, tx, legH + 0.15, tz, 24);
      for (let i = 0; i < 6; i++) k.cyl(steel, R + 0.025, R + 0.03, 0.05, tx, legH + 0.4 + (i * (th - 0.6)) / 5, tz, 24, true);
      k.cyl(mat('#3a3634', { rough: 0.8 }), 0.05, R + 0.15, R * 0.75, tx, legH + 0.15 + th, tz, 24);
      // ladder
      for (let y = 0.3; y < legH + th; y += 0.3) k.box(steel, 0.4, 0.025, 0.025, tx, y, tz + R + 0.15);
      for (const sx of [-0.2, 0.2]) k.box(steel, 0.03, legH + th, 0.03, tx + sx, 0, tz + R + 0.15);
    }
    // vents, a chimney, a skylight hatch, condensers, chairs
    const spots = 6;
    for (let i = 0; i < spots; i++) {
      const x = r.range(-W / 2 + 0.8, W / 2 - 0.8), z = r.range(zA + 0.8, zB - 0.8);
      if (Math.abs(x) < d.SW / 2 + 1.2 && z > d.zBack - 1.2 && z < d.Ld + 1.8) continue;
      if (s.lifts.length && Math.abs(x) > d.hw / 2 - 0.5 && z < d.Ld + 6) continue;
      const what = r.int(0, 3);
      if (what === 0) {
        k.cyl(M.steel(), 0.12, 0.12, 0.9, x, 0, z, 10);
        k.cyl(M.steel(), 0.25, 0.2, 0.18, x, 0.9, z, 10);
      } else if (what === 1 && this.type !== 'office') {
        k.box(mat('#7a4434', { rough: 0.9 }), 0.7, 1.6, 0.5, x, 0, z);
        this.cols.push({ minX: x - 0.35, maxX: x + 0.35, minZ: z - 0.25, maxZ: z + 0.25 });
      } else if (what === 2) {
        k.box(mat('#c9ccc8', { rough: 0.5, metal: 0.3 }), 1.0, 0.9, 0.8, x, 0, z);
        k.cyl(M.black(), 0.3, 0.3, 0.02, x, 0.9, z, 16);
        this.cols.push({ minX: x - 0.5, maxX: x + 0.5, minZ: z - 0.4, maxZ: z + 0.4 });
      } else {
        // a folding chair someone left up here
        k.at(x, 0, z, r.range(0, Math.PI * 2), () => {
          k.box(M.fabric(r.pick(['#2a5a8a', '#c9a030', '#3a6a3a'])), 0.5, 0.03, 0.45, 0, 0.42, 0);
          k.boxM(M.fabric(r.pick(['#2a5a8a', '#c9a030', '#3a6a3a'])), 0.5, 0.5, 0.03, 0, 0.7, -0.24, new THREE.Euler(-0.25, 0, 0));
          for (const sx of [-0.23, 0.23]) k.box(M.steel(), 0.02, 0.42, 0.4, sx, 0, 0);
        });
      }
    }
    yield;
    yield* this.skyline(W, zA, zB);
    this.spawn.pos.set(d.SW / 2 - 0.55, 0, d.Ld + 1.2);
    this.spawn.yaw = Math.PI;
  }

  /** the city around: blocks of buildings rising from the street far below */
  private *skyline(W: number, zA: number, zB: number) {
    const k = new Kit(), r = new Rng(hashN(this.desc.seed, 5150));
    const street = -this.floors * this.d.H - 0.15;
    const styles = ['brick', 'prewar', 'panel', 'glass', 'brick'] as const;
    // facade textures are canvases (cached after the first roof): one per slice
    const matsF: THREE.Material[] = [];
    for (let i = 0; i < styles.length; i++) {
      matsF.push(cached(`skyline:${i}`, () => {
        const f = facade(styles[i], ['#8c5a44', '#b8a888', '#9a948a', '#6a7a8a', '#a87a5a'][i], 0.25, 300 + i);
        return new THREE.MeshStandardMaterial({ map: f.map, emissiveMap: f.emissive, emissive: new THREE.Color('#ffd9a0'), emissiveIntensity: 0.25, roughness: 0.8 });
      }));
      yield;
    }
    const cx = 0, cz = (zA + zB) / 2;
    for (let i = 0; i < 160; i++) {
      const a = r.range(0, Math.PI * 2), dist = r.range(34, 300);
      const x = cx + Math.cos(a) * dist, z = cz + Math.sin(a) * dist;
      if (Math.abs(x) < W / 2 + 10 && z > zA - 10 && z < zB + 10) continue;
      const w = r.range(10, 26), dd = r.range(10, 26);
      // the neighbours across the street are about as tall as this building; towers further off
      const own = -street;
      const h = dist < 70 ? r.range(Math.max(8, own - 8), own + 10) : r.chance(0.15) ? r.range(80, 220) : r.range(12, 60);
      const m2 = r.pick(matsF);
      k.box(m2, w, h, dd, x, street, z, Math.round(a / (Math.PI / 2)) * (Math.PI / 2), 'world', [1 / 12, 1 / 12.8]);
      k.box(mat('#4a4744', { rough: 0.95 }), w, 0.3, dd, x, street + h, z, Math.round(a / (Math.PI / 2)) * (Math.PI / 2));
    }
    const g = new THREE.Group();
    g.name = 'skyline';
    k.finish(g, false);
    this.group.add(g);
  }
}

function* timed(g: Iterator<unknown>, out: number[]) {
  for (;;) {
    const t = performance.now();
    const r = g.next();
    out.push(+(performance.now() - t).toFixed(1));
    if (r.done) return;
    yield;
  }
}

function xyz(p: [number, number], y: number): [number, number, number] {
  return [p[0], y, p[1]];
}

/** ?building=walkup&floors=6&floor=0&bseed=…: a test building to start in */
export function testBuilding(params: URLSearchParams): FloorDesc {
  const type = (params.get('building') ?? 'walkup') as BType;
  const floors = Number(params.get('floors') ?? (type === 'office' ? 12 : type === 'prewar' ? 9 : 5));
  return { kind: 'floor', seed: Number(params.get('bseed') ?? 4242), name: params.get('bname') ?? '214 Orchard St', type: SPECS[type] ? type : 'walkup', floor: Number(params.get('floor') ?? 0), floors };
}
