import * as THREE from 'three';
import { Rng, hashN, paintingName } from './rng';
import { pickModel, spawn, normScale, scaleTo, type ModelEntry } from './assets';
import { box, mat, glow, footprint, rectBox3, blob } from './build';
import { paintingTex, signTex } from './textures';
import { BIOMES, ROLE_BIOMES } from './biomes';
import type { Env, Level, LevelDesc, Portal, Rect } from './level';
import { disposeTree, finishBuilding, overlaps, rect } from './level';
import { getTimeOfDay } from './lighting';
import { Kit } from './rooms/kit';
import { M } from './rooms/mats';
import { rugTex, windowViewTex, photoTex } from './rooms/tex';
import * as F from './rooms/furniture';
import { LIB, pickLib, fillHolder } from './rooms/lib';
import { drawerContents, cabinetContents, upperContents, fridgeContents, closetContents } from './rooms/contents';
import { readFront, detectDrawers, cutOpenings, compartment, frontSampleAt, paintWith, frontMaterial, slotMesh, fillCompartment, themeOf } from './lazy-furniture';
import { adoptContainer, type LazyContainer } from './lazy';
import { houseCore, wantsHouseCore, type HouseCore } from './rooms/vertical';

/**
 * Generated building interiors: a BSP floorplan of real rooms (living rooms, bedrooms, galley
 * kitchens, subway-tiled bathrooms, open-plan offices with glass meeting rooms...), built to the
 * NYC references in docs/research/interiors.md. Architecture and main furniture are procedural
 * and batched (src/rooms/); small objects on surfaces are bundled sand3d models you can shrink into.
 */

const T = 0.16; // wall thickness
const DOOR = 1.0; // opening width
const DOOR_H = 2.13;

export interface Room {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  type: string;
}
interface Split {
  axis: 'x' | 'z'; // 'x': wall at x = c spanning z in [a0, a1]
  c: number;
  a0: number;
  a1: number;
  door: number;
}
interface Opening {
  t: number;
  w: number;
  kind: 'door' | 'exit' | 'window';
  y0: number;
  y1: number;
}
/** one wall of one room, seen from inside it */
interface Side {
  room: Room;
  /** 'z': the wall runs along x at z = c; 'x': it runs along z at x = c */
  axis: 'x' | 'z';
  c: number;
  inward: 1 | -1;
  ext: boolean;
  /** inner face coordinate */
  face: number;
  /** usable extent along the wall (inner corners) */
  e0: number;
  e1: number;
  open: Opening[];
  /** intervals along the wall already taken (openings, door leaves, furniture) and how tall */
  used: { a: number; b: number; h: number }[];
}
/** a room as a visibility cell: everything in it lives under `group`; doors lead to other cells */
export interface Cell {
  room: Room;
  group: THREE.Group;
  kit: Kit;
  bounds: Rect;
  doors: { x: number; z: number; width: number; height: number; axis: 'x' | 'z'; to: Room | 'exit' }[];
}
/**
 * Something with a door or drawers. Its contents do not exist until `generate()` is called
 * (when it is opened); `obj` is an empty group at the container's front-centre base,
 * rotated so local +z points out of its front, and `size` is its outer w/h/d.
 */
export interface Container {
  kind: 'dresser' | 'nightstand' | 'cabinet' | 'upper' | 'fridge' | 'closet';
  obj: THREE.Group;
  size: THREE.Vector3;
  room: Room;
  generate: () => THREE.Object3D;
  door?: THREE.Object3D;
  drawer?: THREE.Object3D;
  open?: (t: number) => void;
  /** the moving part is only drawn while open (drawers added to a library model that has its own fronts) */
  hideClosed?: boolean;
  /** the dark empty slot shown over the model's own front while the drawer is out */
  slot?: THREE.Object3D;
  /** lazy.ts: cut the library model's openings when you come close or press E (see libDrawerSet) */
  prepare?: (() => LazyContainer[] | null) & { ready?: () => boolean };
}
interface Frame {
  x: number;
  z: number;
  rot: number;
}

const STYLE_ROOMS: Record<string, string[]> = {
  house: ['living', 'bedroom', 'dining', 'study', 'bedroom', 'kids', 'bedroom'],
  apartment: ['living', 'bedroom', 'study', 'bedroom', 'dining', 'bedroom'],
  office: ['openplan', 'meeting', 'office', 'pantry', 'meeting', 'office', 'storage', 'office'],
  shop: ['shop', 'shop', 'storage', 'office'],
  museum: ['gallery', 'gallery', 'gallery', 'gallery', 'gallery', 'storage'],
  workshop: ['workshop', 'storage', 'workshop', 'office', 'kitchen'],
  library: ['library', 'library', 'study', 'gallery', 'library'],
};
/** rooms that always go to the smallest leaves */
const SMALL_ROOMS: Record<string, string[]> = {
  house: ['bathroom', 'kitchen'],
  apartment: ['bathroom', 'kitchen'],
  office: ['bathroom'],
};

const WALL_COLS: Record<string, string[]> = {
  apartment: ['#efe9df', '#e9e4d8', '#f1ede6', '#dfe3dc', '#e6dccd', '#d8dde0', '#ece3d3'],
  house: ['#e8dcc8', '#d9e0d4', '#e6d3c3', '#d3dbe0', '#efe7d6', '#c9d2c6', '#e2d2d2'],
  office: ['#eeeeec', '#f1f1ef', '#e8e9ea'],
};
const FABRICS = ['#3d4a5c', '#7b7468', '#5a6b5a', '#a39885', '#2f3d4f', '#8a5a4a', '#c9c0ae', '#4f4a52', '#6e7f8a'];
const ACCENTS = ['#c4553a', '#e8c86a', '#2d4f6b', '#7a8a6a', '#e9e2d4', '#8a3b4a', '#3a6b6b'];

// generic placement for the rarer room types (shops, galleries, workshops, storage)
interface Spec {
  role: string;
  where: 'wall' | 'center' | 'free' | 'corner';
  n: [number, number];
  on?: string[];
  onN?: [number, number];
  chairs?: [number, number];
}
const GENERIC: Record<string, { floor: 'wood' | 'tile' | 'carpet'; items: Spec[]; paintings: [number, number] }> = {
  kids: {
    floor: 'wood', paintings: [1, 2],
    items: [
      { role: 'storage', where: 'wall', n: [1, 1], on: ['toy', 'toy', 'stationery'], onN: [1, 3] },
      { role: 'toy', where: 'free', n: [3, 6] },
      { role: 'sports', where: 'free', n: [1, 2] },
      { role: 'craft', where: 'free', n: [0, 2] },
    ],
  },
  storage: {
    floor: 'tile', paintings: [0, 0],
    items: [
      { role: 'storage', where: 'wall', n: [3, 6], on: ['container', 'tool', 'sports', 'container'], onN: [1, 3] },
      { role: 'container', where: 'free', n: [3, 7] },
      { role: 'machine', where: 'wall', n: [0, 1] },
    ],
  },
  shop: {
    floor: 'tile', paintings: [0, 1],
    items: [
      { role: 'storage', where: 'wall', n: [3, 6], on: ['toy', 'food', 'tableware', 'electronics', 'stationery', 'container'], onN: [2, 4] },
      { role: 'table', where: 'center', n: [1, 1], on: ['toy', 'food', 'tableware', 'electronics', 'craft'], onN: [3, 6] },
      { role: 'container', where: 'corner', n: [1, 3] },
      { role: 'appliance', where: 'wall', n: [0, 1] },
    ],
  },
  gallery: {
    floor: 'wood', paintings: [3, 6],
    items: [
      { role: 'pedestal', where: 'free', n: [3, 6] },
      { role: 'instrument', where: 'wall', n: [0, 1] },
      { role: 'gear', where: 'wall', n: [0, 2] },
      { role: 'machine', where: 'wall', n: [0, 1] },
    ],
  },
  workshop: {
    floor: 'tile', paintings: [0, 1],
    items: [
      { role: 'machine', where: 'wall', n: [1, 3] },
      { role: 'table', where: 'wall', n: [1, 2], on: ['tool', 'tool', 'container'], onN: [2, 4] },
      { role: 'storage', where: 'wall', n: [1, 2], on: ['tool', 'container'], onN: [1, 3] },
      { role: 'container', where: 'free', n: [2, 4] },
    ],
  },
};

const PEDESTAL_ROLES = ['craft', 'gear', 'toy', 'instrument', 'vehicle', 'building', 'machine', 'electronics', 'food', 'tableware', 'sports'];
const NOT_PORTAL = new Set(['chair', 'table', 'pedestal']);

export class InteriorLevel implements Level {
  name: string;
  group = new THREE.Group();
  spawn = { pos: new THREE.Vector3(), yaw: 0 };
  env: Env;
  /** generated rooms (for the lab and for debugging) */
  rooms: Room[] = [];
  private cols: Rect[] = [];
  private ports: Portal[] = [];
  private rng: Rng;
  private lights: { light: THREE.PointLight; room: Room }[] = [];
  private shadowLight: THREE.PointLight | null = null;
  /** one cell per room: its own group and geometry batch, so unseen rooms can be skipped */
  cells: Cell[] = [];
  /** the entry (exit) door in level coordinates: centre of the doorway on the inner wall face; yaw faces into the building */
  entry = { x: 0, z: 0, width: DOOR, height: DOOR_H, yaw: Math.PI };
  /**
   * the in-unit stair (houses / direct-from-street multi-floor units), for src/rooms/vertical.ts:
   * centre, rotation (local +x runs up the flight from the bottom at -len/2... see placeStairs), size and footprint.
   * Units reached from a building hall (vertical.ts, floors: 1) have none.
   */
  stairCore?: { x: number; z: number; rot: number; len: number; width: number; rect: Rect };
  /** every piece placed against a wall: its centre, the way its front faces (rot), and its room (for qa) */
  placed: { x: number; z: number; rot: number; w: number; d: number; room: Room }[] = [];
  /** openable containers whose contents are generated only when needed (see Container) */
  containers: Container[] = [];
  private cellMap = new Map<Room, Cell>();
  private cur!: Cell;
  private get kit() {
    return this.cur.kit;
  }
  private use(rm: Room) {
    this.cur = this.cellMap.get(rm)!;
  }
  private sides = new Map<Room, Side[]>();
  private H: number;
  private style: string;
  private night: boolean;
  private paint = new Map<Room, THREE.Material>();
  private roomFabric = new Map<Room, THREE.Material>();
  private curtainRooms = new Set<Room>();
  /** wall panel mouldings in pre-war rooms */
  private panels: 'tall' | 'wainscot' | 'none' = 'none';
  private pal: { wood: THREE.Material; dark: THREE.Material; fabric: THREE.Material; accent: THREE.Material[]; metal: THREE.Material; door: THREE.Material; cab: THREE.Material; counter: THREE.Material };

  /** seamless.ts: the doorway you come in by, and the construction left to do when staged */
  doorway?: Level['doorway'];
  staging?: Iterator<unknown>;
  /** ---- vertical.ts hook: a multi-floor house's stair core (src/rooms/vertical.ts HouseCore), the same on every floor */
  vcore: HouseCore | null = null;
  prefetch(p: THREE.Vector3): LevelDesc[] {
    return this.vcore?.prefetch(p) ?? [];
  }
  // ---- end vertical hook

  constructor(private desc: Extract<LevelDesc, { kind: 'interior' }>, opts: { staged?: boolean } = {}) {
    this.rng = new Rng(hashN(desc.seed, desc.floor));
    this.name = desc.floor > 0 ? `${desc.name} · floor ${desc.floor + 1}` : desc.name;
    const b = BIOMES[desc.biome] ?? BIOMES.town;
    // night views and dimmer daylight when the world outside is dark
    this.night = !!b.night || getTimeOfDay() === 'night' || getTimeOfDay() === 'dusk';
    this.style = desc.style === 'store' ? 'shop' : desc.style;
    this.H = this.style === 'house' ? 3.35 : this.style === 'office' ? 2.85 : this.style === 'museum' ? 3.8 : 3.05;
    this.env = {
      skyTop: '#1a1612', skyBottom: '#2a241e', stars: false, fog: null, fogNear: 0, fogFar: 0, sun: null,
      hemi: { sky: '#fff1dc', ground: '#6a5a48', intensity: this.night ? 0.25 : 0.42 }, ambient: 0.05, envIntensity: 0.35, exposure: 1.0,
    };
    const r = this.rng;
    this.pal = {
      wood: r.pick([M.oak('#d9c2a0'), M.walnut('#ffffff'), M.oak('#ffffff'), M.walnut('#c8b8a8')]),
      dark: M.walnut('#9a8a7a'),
      fabric: M.fabric(r.pick(FABRICS)),
      accent: [M.velvet(r.pick(ACCENTS)), M.fabric(r.pick(ACCENTS)), M.fabric(r.pick(ACCENTS))],
      metal: r.chance(0.5) ? M.brass() : M.black(),
      door: r.chance(0.8) ? M.trim() : M.painted(r.pick(['#2f3a40', '#4a3a2e', '#d8d2c4'])),
      cab: r.pick([M.painted('#f1eee6'), M.painted('#c9cfc6'), M.painted('#2f3d4a'), M.painted('#d9d2c2'), M.oak('#e8d8c0')]),
      counter: r.pick([M.marble('#ffffff'), M.marble('#ffffff'), M.marble('#5a5a5a'), M.oak('#c9a070')]),
    };
    this.staging = this.generate();
    if (!opts.staged) finishBuilding(this);
  }

  colliders() {
    return this.cols;
  }
  portals() {
    return this.ports;
  }
  update(_dt: number, p: THREE.Vector3, _time: number) {
    // the room you stand in gets the one shadow-casting light, so furniture grounds itself
    if (!this.shadowLight) return;
    const here = this.lights.find((l) => p.x >= l.room.x0 && p.x <= l.room.x1 && p.z >= l.room.z0 && p.z <= l.room.z1) ?? this.lights[0];
    if (!here) return;
    for (const l of this.lights) l.light.intensity = l === here ? 0 : l.light.userData.base;
    this.shadowLight.position.copy(here.light.position);
    this.shadowLight.intensity = here.light.userData.base;
    this.shadowLight.distance = here.light.distance;
  }
  dispose() {
    disposeTree(this.group);
    this.vcore?.dispose(); // vertical.ts hook
  }

  // ------------------------------------------------------------------ layout

  private *generate() {
    const r = this.rng;
    const style = this.style;
    const big = style === 'museum' || style === 'office' || style === 'shop';
    // ---- vertical.ts hook: a house with a stair core has the same footprint on every floor
    const rf = wantsHouseCore(this.desc) ? new Rng(hashN(this.desc.seed, 4711)) : r;
    const W = style === 'apartment' ? rf.range(11, 16) : rf.range(big ? 18 : 13, big ? 26 : 19);
    const D = style === 'apartment' ? rf.range(9, 13) : rf.range(big ? 14 : 10, big ? 22 : 15);
    const bounds = { x0: -W / 2, z0: -D / 2, x1: W / 2, z1: D / 2 };
    // the stair hall behind the back wall (its doorway near the -x corner, where no BSP wall ends)
    const core = (this.vcore = houseCore(this.desc, bounds, this.H, T));
    // ---- end vertical hook
    // upper floors of a house with a stair core have no street door: you arrive by the stair hall
    const upper = !!core && this.desc.floor > 0;

    // BSP into rooms
    const leaves: Room[] = [];
    const splits: Split[] = [];
    const minRoom = style === 'museum' ? 6 : style === 'office' ? 4 : 3.0;
    const divide = (x0: number, z0: number, x1: number, z1: number, depth: number) => {
      const w = x1 - x0, d = z1 - z0;
      const area = w * d;
      const stop = (area < (style === 'office' ? 40 : 26) && depth > 0) || depth > 4 || (depth >= 2 && r.chance(0.3)) || (w < minRoom * 2 && d < minRoom * 2);
      if (stop) {
        leaves.push({ x0, z0, x1, z1, type: '' });
        return;
      }
      const vertical = w > d * 1.2 ? true : d > w * 1.2 ? false : r.chance(0.5);
      if (vertical && w >= minRoom * 2) {
        const c = x0 + w * r.range(0.36, 0.64);
        splits.push({ axis: 'x', c, a0: z0, a1: z1, door: 0 });
        divide(x0, z0, c, z1, depth + 1);
        divide(c, z0, x1, z1, depth + 1);
      } else if (!vertical && d >= minRoom * 2) {
        const c = z0 + d * r.range(0.36, 0.64);
        splits.push({ axis: 'z', c, a0: x0, a1: x1, door: 0 });
        divide(x0, z0, x1, c, depth + 1);
        divide(x0, c, x1, z1, depth + 1);
      } else {
        leaves.push({ x0, z0, x1, z1, type: '' });
      }
    };
    divide(bounds.x0, bounds.z0, bounds.x1, bounds.z1, 0);
    this.rooms = leaves;

    // one door per split, away from T-junctions and corners (room for the door leaf too)
    for (const s of splits) {
      const blockers = splits.filter((o) => o.axis !== s.axis && o.c > s.a0 && o.c < s.a1 && s.c >= o.a0 - 0.01 && s.c <= o.a1 + 0.01).map((o) => o.c);
      const ends = [s.a0, s.a1, ...blockers];
      let best = (s.a0 + s.a1) / 2;
      for (let k = 0; k < 60; k++) {
        const t = r.range(s.a0 + 0.8, s.a1 - 0.8);
        if (ends.every((b) => Math.abs(b - t) > DOOR / 2 + 0.25) && ends.filter((b) => Math.abs(b - t) > DOOR / 2 + 1.05).length >= 1) {
          best = t;
          break;
        }
      }
      s.door = best;
    }

    // exit door on the +z wall (the building corridor)
    const zBlock = splits.filter((o) => o.axis === 'x' && Math.abs(o.a1 - bounds.z1) < 0.01).map((o) => o.c);
    let exitX = 0;
    for (let k = 0; k < 40; k++) {
      const t = r.range(bounds.x0 + 1.2, bounds.x1 - 1.2);
      if (zBlock.every((b) => Math.abs(b - t) > DOOR / 2 + 0.4)) {
        exitX = t;
        break;
      }
    }
    this.spawn.pos.set(exitX, 0, bounds.z1 - 1.2);
    this.spawn.yaw = 0;
    this.doorway = { pos: new THREE.Vector3(exitX, 0, bounds.z1), yaw: 0 };

    // room types: big rooms get the main types, the smallest the bathroom (and a small kitchen)
    const types = STYLE_ROOMS[style] ?? STYLE_ROOMS.house;
    const small = [...(SMALL_ROOMS[style] ?? [])];
    const sorted = [...leaves].sort((a, b) => area(b) - area(a));
    const ascending = [...sorted].reverse();
    const assigned = new Set<Room>();
    small.forEach((t, i) => {
      const rm = ascending[i];
      if (rm && sorted.length > small.length + 1) {
        rm.type = t;
        assigned.add(rm);
      }
    });
    let ti = 0;
    for (const rm of sorted) if (!assigned.has(rm)) rm.type = types[ti++ % types.length];
    // offices: the room you walk into is the reception
    if (style === 'office') {
      const front = leaves.find((q) => exitX > q.x0 && exitX < q.x1 && Math.abs(q.z1 - bounds.z1) < 0.01);
      if (front && front !== sorted[0] && front.type !== 'bathroom') front.type = 'reception';
    }

    // walls, openings and windows per room side
    for (const rm of leaves) this.sides.set(rm, this.makeSides(rm, bounds));
    for (const s of splits) {
      for (const rm of leaves) {
        for (const sd of this.sides.get(rm)!) {
          if (sd.axis !== s.axis || Math.abs(sd.c - s.c) > 0.01) continue;
          if (s.door > sd.e0 && s.door < sd.e1) sd.open.push({ t: s.door, w: DOOR, kind: 'door', y0: 0, y1: DOOR_H });
        }
      }
    }
    for (const rm of leaves) {
      for (const sd of this.sides.get(rm)!) {
        if (!upper && sd.axis === 'z' && Math.abs(sd.c - bounds.z1) < 0.01 && exitX > sd.e0 && exitX < sd.e1) sd.open.push({ t: exitX, w: DOOR, kind: 'exit', y0: 0, y1: DOOR_H });
        // vertical.ts hook: the doorway to the stair core (that wall gets no windows)
        const coreSide = !!core && sd.axis === 'z' && Math.abs(sd.c - bounds.z0) < 0.01 && core.door.x > sd.e0 && core.door.x < sd.e1;
        if (core && coreSide) sd.open.push({ t: core.door.x, w: core.door.w, kind: 'door', y0: 0, y1: DOOR_H });
        if (sd.ext && !coreSide && !(sd.axis === 'z' && Math.abs(sd.c - bounds.z1) < 0.01)) this.windows(sd);
        for (const o of sd.open) sd.used.push({ a: o.t - o.w / 2 - (o.kind === 'window' ? 0.12 : 0.15), b: o.t + o.w / 2 + (o.kind === 'window' ? 0.12 : 0.15), h: 9 });
      }
    }

    // paint per room
    const cols = WALL_COLS[style] ?? WALL_COLS.house;
    const base = r.pick(cols);
    this.panels = style === 'house' ? (r.chance(0.6) ? 'tall' : 'wainscot') : style === 'apartment' ? r.pick(['tall', 'wainscot', 'none', 'tall'] as const) : 'none';
    for (const rm of leaves) {
      // brownstones: patterned wallpaper in some bedrooms, dining rooms and studies
      if (style === 'house' && ['bedroom', 'dining', 'study'].includes(rm.type) && r.chance(0.6)) this.paint.set(rm, M.wallpaper(r.int(0, 99), r.pick(['#e8dcc8', '#d9e0d4', '#e6d3c3', '#c9d2c6', '#2f3d4a', '#5a3a3a'])));
      else this.paint.set(rm, M.paint(r.chance(0.6) ? base : r.pick(cols)));
      this.roomFabric.set(rm, M.drape(r.pick(['#ece6da', '#e4dccb', '#d9d4c8', '#b9c2c4', '#8a96a3', '#c9b79c', '#6e7f6a', '#7a4a42'])));
      if (r.chance(0.55)) this.curtainRooms.add(rm);
    }

    // which room gets the stairs up
    const canGoUp = this.desc.floor < this.desc.floors - 1 && !core; // vertical.ts hook: the core has the stair
    const stairRoom = canGoUp ? sorted.find((rm) => rm.type !== 'bathroom' && !(exitX > rm.x0 && exitX < rm.x1 && rm.z1 === bounds.z1)) ?? sorted[0] : null;

    // door clearance zones (both sides of every doorway)
    const doorZones: Rect[] = splits.map((s) => (s.axis === 'x' ? rect(s.c, s.door, 2.0, DOOR + 0.3) : rect(s.door, s.c, DOOR + 0.3, 2.0)));
    if (!upper) doorZones.push(rect(exitX, bounds.z1 - 0.9, DOOR + 0.6, 2.0));
    if (core) doorZones.push(rect(core.door.x, bounds.z0 + 0.9, core.door.w + 0.6, 2.0)); // vertical.ts hook

    // architecture
    for (const rm of leaves) {
      const cell: Cell = { room: rm, group: new THREE.Group(), kit: new Kit(), bounds: { minX: rm.x0, minZ: rm.z0, maxX: rm.x1, maxZ: rm.z1 }, doors: [] };
      cell.group.name = `room:${rm.type}`;
      this.group.add(cell.group);
      this.cells.push(cell);
      this.cellMap.set(rm, cell);
    }
    for (const rm of leaves) {
      this.use(rm);
      for (const sd of this.sides.get(rm)!) {
        this.wall(sd, leaves);
        for (const o of sd.open) {
          if (o.kind === 'window') continue;
          const [x, z] = this.at(sd, o.t, -T / 2);
          const other = o.kind === 'exit' ? 'exit' : leaves.find((q) => q !== rm && x >= q.x0 - 0.01 && x <= q.x1 + 0.01 && z >= q.z0 - 0.01 && z <= q.z1 + 0.01 && this.sides.get(q)!.some((s2) => s2.axis === sd.axis && Math.abs(s2.c - sd.c) < 0.01));
          if (other) this.cellMap.get(rm)!.doors.push({ x, z, width: o.w, height: o.y1, axis: sd.axis, to: other });
        }
      }
    }
    this.doorLeaves(splits, leaves);
    this.use(leaves.find((q) => exitX > q.x0 && exitX < q.x1 && Math.abs(q.z1 - bounds.z1) < 0.01) ?? leaves[0]);
    if (upper && core) {
      // arrive from the stair hall: its doorway in the back wall is the entry
      this.entry = { x: core.door.x, z: bounds.z0 + T / 2, width: core.door.w, height: DOOR_H, yaw: 0 };
      this.spawn.pos.set(core.door.x, 0, bounds.z0 + 1.2);
      this.spawn.yaw = Math.PI;
      this.doorway = { pos: new THREE.Vector3(core.door.x, 0, bounds.z0), yaw: Math.PI };
    } else {
      this.exitDoor(exitX, bounds);
      this.entry = { x: exitX, z: bounds.z1 - T / 2, width: DOOR, height: DOOR_H, yaw: Math.PI };
    }
    for (const rm of leaves) {
      this.use(rm);
      this.floorAndCeiling(rm);
    }
    yield;

    // lights: one warm ceiling light per room, plus one shadow-casting light that follows you
    sorted.forEach((rm, i) => {
      if (i >= 12) return;
      const a = area(rm);
      const pl = new THREE.PointLight(rm.type === 'bathroom' || rm.type === 'kitchen' ? '#fff0dc' : '#ffdcb0', 0, Math.sqrt(a) * 2.6 + 3, 2);
      const inten = (style === 'office' ? 14 : 9) + a * (style === 'office' ? 1.1 : 0.75);
      pl.intensity = inten;
      pl.userData.base = inten;
      pl.position.set((rm.x0 + rm.x1) / 2, this.H - 0.95, (rm.z0 + rm.z1) / 2);
      this.group.add(pl);
      this.lights.push({ light: pl, room: rm });
    });
    // ---- vertical.ts hook: houses with a core keep the same number of lights on every floor (no shader
    // recompiles when walking up), one of the spare ones lighting the stair hall
    if (core) {
      for (let i = this.lights.length; i < 12; i++) {
        const pl = new THREE.PointLight('#ffdcb0', i === this.lights.length ? 6 : 0, 8, 2);
        pl.position.set(core.ox, this.H * 0.5 + 1.6, core.oz - core.d.Lf - core.d.Md / 2);
        this.group.add(pl);
      }
      this.cols.push(...core.colliders());
      yield* core.build();
      this.group.add(core.well);
    }
    // ---- end vertical hook
    if (this.lights.length) {
      const sl = new THREE.PointLight('#ffdcb0', 0, 10, 2);
      sl.castShadow = true;
      sl.shadow.mapSize.set(512, 512);
      sl.shadow.bias = -0.002;
      sl.shadow.radius = 4;
      sl.shadow.camera.near = 0.1;
      this.group.add(sl);
      this.shadowLight = sl;
      this.update(0, this.spawn.pos, 0);
    }

    for (const rm of sorted) {
      yield;
      this.use(rm);
      this.furnish(rm, doorZones, rm === stairRoom);
    }
    yield;

    for (const c of this.cells) c.kit.finish(c.group);
    this.group.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (m === M.ceiling() || m === M.dropCeiling()) o.userData.ceiling = true;
    });
  }

  private makeSides(rm: Room, b: { x0: number; z0: number; x1: number; z1: number }): Side[] {
    const mk = (axis: 'x' | 'z', c: number, inward: 1 | -1, ext: boolean): Side => {
      const e0 = (axis === 'z' ? rm.x0 : rm.z0) + T / 2;
      const e1 = (axis === 'z' ? rm.x1 : rm.z1) - T / 2;
      return { room: rm, axis, c, inward, ext, face: c + (inward * T) / 2, e0, e1, open: [], used: [] };
    };
    const near = (a: number, bb: number) => Math.abs(a - bb) < 0.01;
    return [
      mk('z', rm.z0, 1, near(rm.z0, b.z0)),
      mk('z', rm.z1, -1, near(rm.z1, b.z1)),
      mk('x', rm.x0, 1, near(rm.x0, b.x0)),
      mk('x', rm.x1, -1, near(rm.x1, b.x1)),
    ];
  }

  private windows(sd: Side) {
    const L = sd.e1 - sd.e0;
    const office = this.style === 'office';
    const ww = office ? 1.5 : this.style === 'house' ? 1.05 : 0.95;
    const sill = office ? 0.75 : this.style === 'house' ? 0.55 : 0.78;
    const top = this.H - (office ? 0.35 : 0.55);
    let n = Math.floor((L - 0.6) / (ww + (office ? 0.6 : 1.1)));
    if (sd.room.type === 'bathroom') n = Math.min(n, 1);
    if (n <= 0) return;
    // pairs of windows read as NYC: keep them grouped about the middle of the wall
    const pitch = Math.min(L / n, ww + (office ? 0.7 : 1.3));
    const mid = (sd.e0 + sd.e1) / 2;
    for (let i = 0; i < n; i++) sd.open.push({ t: mid + (i - (n - 1) / 2) * pitch, w: ww, kind: 'window', y0: sill, y1: top });
  }

  /** a point `o` metres in from the inner face of a side, at `t` along it */
  private at(sd: Side, t: number, o: number): [number, number] {
    const p = sd.face + sd.inward * o;
    return sd.axis === 'z' ? [t, p] : [p, t];
  }
  /** rotation that turns a piece's front (+z) to face into the room from this side */
  private rotOf(sd: Side) {
    return sd.axis === 'z' ? (sd.inward > 0 ? 0 : Math.PI) : sd.inward > 0 ? Math.PI / 2 : -Math.PI / 2;
  }
  /** rotation that turns local +x along the side (increasing t) */
  private alongRot(sd: Side) {
    return sd.axis === 'z' ? 0 : -Math.PI / 2;
  }

  // ------------------------------------------------------------------ architecture

  /** the room's half of a wall (full thickness on the outside), its trim, casings and windows */
  private wall(sd: Side, rooms: Room[]) {
    const k = this.kit;
    const H = this.H;
    const rm = sd.room;
    const office = this.style === 'office';
    const bath = rm.type === 'bathroom';
    const paint = this.paint.get(rm)!;
    const tile = M.subway();
    const wains = 1.22;
    // glass partition where this side borders a meeting room (offices)
    const glassAt = (t: number) => {
      if (!office || sd.ext) return false;
      if (rm.type === 'meeting') return true;
      return rooms.some((o) => o !== rm && o.type === 'meeting' && this.sides.get(o)?.some((s2) => s2.axis === sd.axis && Math.abs(s2.c - sd.c) < 0.01 && t > s2.e0 - T && t < s2.e1 + T));
    };
    // thickness span of this wall half
    const t0 = sd.ext ? sd.c - (sd.inward * T) / 2 : sd.c;
    const t1 = sd.face;
    const thick = Math.abs(t1 - t0);
    const mid = (t0 + t1) / 2;
    const a0 = sd.axis === 'z' ? (sd.inward > 0 ? rm.x0 : rm.x0) : sd.e0;
    const a1 = sd.axis === 'z' ? rm.x1 : sd.e1;
    // a block of wall from a to b (along), y0 to y1
    const block = (a: number, b: number, y0: number, y1: number) => {
      if (b - a < 0.005 || y1 - y0 < 0.005) return;
      const len = b - a, m = (a + b) / 2;
      const put = (mt: THREE.Material, ya: number, yb: number, proud = 0) => {
        if (yb - ya < 0.005) return;
        const th = thick + proud;
        const c = mid + (sd.inward * proud) / 2;
        if (sd.axis === 'z') k.box(mt, len, yb - ya, th, m, ya, c);
        else k.box(mt, th, yb - ya, len, c, ya, m);
      };
      if (bath && y0 < wains) {
        put(tile, y0, Math.min(y1, wains), 0.01);
        put(paint, wains, y1);
      } else put(paint, y0, y1);
    };
    // cut the wall around its openings
    const opens = [...sd.open].sort((p, q) => p.t - q.t);
    let a = a0;
    const glassSegs: [number, number][] = [];
    const solid = (s0: number, s1: number) => {
      // split by glass runs
      if (!office) return block(s0, s1, 0, H);
      const N = Math.max(1, Math.ceil((s1 - s0) / 0.3));
      let runStart = s0, runGlass = glassAt(s0 + 0.01);
      for (let i = 1; i <= N; i++) {
        const t = i === N ? s1 : s0 + ((s1 - s0) * i) / N;
        const g = i === N ? !runGlass : glassAt(t);
        if (g !== runGlass || i === N) {
          if (runGlass) glassSegs.push([runStart, t]);
          else block(runStart, t, 0, H);
          runStart = t;
          runGlass = g;
        }
      }
    };
    for (const o of opens) {
      solid(a, o.t - o.w / 2);
      block(o.t - o.w / 2, o.t + o.w / 2, 0, o.y0);
      block(o.t - o.w / 2, o.t + o.w / 2, o.y1, H);
      a = o.t + o.w / 2;
    }
    solid(a, a1);
    for (const [g0, g1] of glassSegs) if (rm.type === 'meeting') this.glassWall(sd, g0, g1);

    // colliders follow the solid wall
    let ca = a0;
    for (const o of opens) {
      if (o.kind !== 'window') {
        this.wallCollider(sd, ca, o.t - o.w / 2);
        ca = o.t + o.w / 2;
      }
    }
    this.wallCollider(sd, ca, a1);

    // trim: baseboard along the floor (not across doorways), crown at the ceiling
    const trim = office ? M.matte('#4a4a4c') : M.trim();
    const along = (s0: number, s1: number, y: number, h: number, depth: number, mt: THREE.Material) => {
      if (s1 - s0 < 0.01) return;
      const [x, z] = this.at(sd, (s0 + s1) / 2, depth / 2);
      if (sd.axis === 'z') k.box(mt, s1 - s0, h, depth, x, y, z);
      else k.box(mt, depth, h, s1 - s0, x, y, z);
    };
    let b0 = sd.e0;
    const baseH = office ? 0.1 : bath ? 0.12 : 0.2;
    const baseM = bath ? M.matte('#2a2a2a') : trim;
    for (const o of opens) {
      if (o.kind === 'window') continue;
      along(b0, o.t - o.w / 2 - 0.09, 0, baseH, 0.018, baseM);
      if (!bath && !office) along(b0, o.t - o.w / 2 - 0.09, baseH, 0.02, 0.03, trim);
      b0 = o.t + o.w / 2 + 0.09;
    }
    along(b0, sd.e1, 0, baseH, 0.018, baseM);
    if (!bath && !office) along(b0, sd.e1, baseH, 0.02, 0.03, trim);
    if (bath) {
      // tile cap along the wainscot, broken by doorways
      let w0 = sd.e0;
      for (const o of opens) {
        if (o.kind === 'window' && o.y0 > wains) continue;
        along(w0, o.t - o.w / 2, wains, 0.05, 0.03, M.porcelain());
        w0 = o.t + o.w / 2;
      }
      along(w0, sd.e1, wains, 0.05, 0.03, M.porcelain());
    }
    if (!office) {
      // crown: a cove of three steps
      along(sd.e0 - 0.1, sd.e1 + 0.1, H - 0.16, 0.16, 0.025, trim);
      along(sd.e0 - 0.1, sd.e1 + 0.1, H - 0.1, 0.1, 0.06, trim);
      along(sd.e0 - 0.1, sd.e1 + 0.1, H - 0.045, 0.045, 0.11, trim);
      if (this.style === 'house') along(sd.e0, sd.e1, H - 0.48, 0.035, 0.02, trim); // picture rail
    }

    // panel mouldings on the stretches of wall between openings (pre-war living, dining, bedrooms)
    if (this.panels !== 'none' && ['living', 'dining', 'bedroom', 'study'].includes(rm.type)) this.wallPanels(sd, opens, along, trim);

    // openings: casings, jambs, windows
    for (const o of opens) {
      const hw = o.w / 2;
      const cw = office ? 0.05 : 0.09;
      const casing = o.kind === 'window' && office ? M.iron() : trim;
      const legY0 = o.kind === 'window' ? o.y0 - 0.08 : 0;
      // jamb lining (the reveal)
      const jamb = (t: number, y0: number, y1: number) => {
        const [x, z] = [sd.axis === 'z' ? t : mid, sd.axis === 'z' ? mid : t];
        if (sd.axis === 'z') k.box(casing, 0.02, y1 - y0, thick, x, y0, z);
        else k.box(casing, thick, y1 - y0, 0.02, x, y0, z);
      };
      jamb(o.t - hw + 0.01, o.y0, o.y1);
      jamb(o.t + hw - 0.01, o.y0, o.y1);
      if (sd.axis === 'z') k.box(casing, o.w, 0.02, thick, o.t, o.y1 - 0.02, mid);
      else k.box(casing, thick, 0.02, o.w, mid, o.y1 - 0.02, o.t);
      // casing on the room face
      along(o.t - hw - cw, o.t - hw, legY0, o.y1 + cw - legY0, 0.025, casing);
      along(o.t + hw, o.t + hw + cw, legY0, o.y1 + cw - legY0, 0.025, casing);
      along(o.t - hw - cw - 0.015, o.t + hw + cw + 0.015, o.y1 + cw - 0.005, 0.04, 0.035, casing);
      if (o.kind === 'window') this.window(sd, o, thick, mid);
    }
  }

  private wallCollider(sd: Side, s0: number, s1: number) {
    if (s1 - s0 < 0.02) return;
    const m = (s0 + s1) / 2;
    const c = sd.ext ? sd.c : sd.c + (sd.inward * T) / 4;
    const th = sd.ext ? T + 0.1 : T / 2 + 0.05;
    this.cols.push(sd.axis === 'z' ? rect(m, c, s1 - s0, th) : rect(c, m, th, s1 - s0));
  }

  private glassWall(sd: Side, s0: number, s1: number) {
    const k = this.kit;
    const H = this.H;
    const len = s1 - s0, m = (s0 + s1) / 2;
    const frame = M.matte('#2b2c2e');
    const put = (mt: THREE.Material, a: number, b: number, y0: number, y1: number, th: number) => {
      if (sd.axis === 'z') k.box(mt, b - a, y1 - y0, th, (a + b) / 2, y0, sd.c);
      else k.box(mt, th, y1 - y0, b - a, sd.c, y0, (a + b) / 2);
    };
    put(M.glass(), s0, s1, 0.05, H - 0.05, 0.012);
    put(M.frosted(), s0, s1, 1.0, 1.35, 0.016);
    put(frame, s0, s1, 0, 0.06, 0.06);
    put(frame, s0, s1, H - 0.06, H, 0.06);
    const n = Math.max(1, Math.round(len / 1.2));
    for (let i = 0; i <= n; i++) {
      const t = s0 + (len * i) / n;
      put(frame, t - 0.025, t + 0.025, 0, H, 0.06);
    }
    void m;
  }

  private wallPanels(sd: Side, opens: Opening[], along: (s0: number, s1: number, y: number, h: number, depth: number, mt: THREE.Material) => void, trim: THREE.Material) {
    const H = this.H;
    const tall = this.panels === 'tall';
    const y0 = tall ? 0.42 : 0.32, y1 = tall ? H - 0.5 : 0.78;
    const bar = 0.035, dep = 0.016;
    let a = sd.e0;
    const stretches: [number, number][] = [];
    for (const o of [...opens].sort((p, q) => p.t - q.t)) {
      stretches.push([a, o.t - o.w / 2 - 0.12]);
      a = o.t + o.w / 2 + 0.12;
    }
    stretches.push([a, sd.e1]);
    for (const [s0, s1] of stretches) {
      if (!tall) along(s0 - 0.03, s1 + 0.03, 0.88, 0.05, 0.025, trim); // chair rail
      const L = s1 - s0 - 0.24;
      if (L < 0.45) continue;
      const n = Math.max(1, Math.round(L / (tall ? 1.1 : 0.9)));
      const pw = L / n;
      for (let i = 0; i < n; i++) {
        const p0 = s0 + 0.12 + pw * i + 0.06, p1 = p0 + pw - 0.12;
        along(p0, p1, y0, bar, dep, trim);
        along(p0, p1, y1 - bar, bar, dep, trim);
        along(p0, p0 + bar, y0, y1 - y0, dep, trim);
        along(p1 - bar, p1, y0, y1 - y0, dep, trim);
      }
    }
  }

  /** curtains or a roman shade for a window */
  private treatment(sd: Side, o: Opening) {
    const k = this.kit;
    const r = this.rng;
    const t = sd.room.type;
    if (this.style === 'office' || t === 'bathroom') return;
    const fabric = this.roomFabric.get(sd.room) ?? M.drape('#e9e2d4');
    const h = o.y1 - o.y0;
    const curtains = ['living', 'bedroom', 'dining', 'study'].includes(t) && this.curtainRooms.has(sd.room);
    const rot = this.alongRot(sd);
    if (curtains) {
      const rodY = Math.min(this.H - 0.2, o.y1 + 0.25);
      const [rx, rz] = this.at(sd, o.t, 0.1);
      k.at(rx, 0, rz, rot, () => {
        const dir = sd.axis === 'z' ? sd.inward : -sd.inward;
        k.rod(M.brass(), 0.014, o.w + 1.0, 0, rodY, 0, 'x', 8);
        for (const sx of [-1, 1]) k.sphere(M.brass(), 0.03, sx * (o.w / 2 + 0.5), rodY, 0);
        for (const sx of [-1, 1]) {
          const geo = curtainGeo(0.42, rodY - 0.02);
          const m = new THREE.Matrix4().makeTranslation(sx * (o.w / 2 + 0.24), (rodY - 0.02) / 2, dir * 0.02);
          k.add(geo, fabric, m, 'keep');
        }
      });
      sd.used.push({ a: o.t - o.w / 2 - 0.5, b: o.t + o.w / 2 + 0.5, h: 1.0 });
    } else {
      // roman shade pulled part way down, inside the casing
      const drop = h * r.range(0.18, 0.45);
      const [x, z] = this.at(sd, o.t, 0.03);
      k.at(x, 0, z, rot, () => {
        const dir = sd.axis === 'z' ? sd.inward : -sd.inward;
        const folds = Math.max(2, Math.round(drop / 0.12));
        for (let i = 0; i < folds; i++) k.box(fabric, o.w - 0.04, drop / folds - 0.004, 0.03 + (i === folds - 1 ? 0.015 : 0), 0, o.y1 - (drop * (i + 1)) / folds, dir * 0.01);
        k.box(M.matte('#e8e2d6'), o.w - 0.04, 0.03, 0.035, 0, o.y1 - drop - 0.03, dir * 0.015);
      });
    }
  }

  private window(sd: Side, o: Opening, thick: number, mid: number) {
    const k = this.kit;
    const r = this.rng;
    const office = this.style === 'office';
    const hw = o.w / 2;
    const frame = office ? M.iron() : M.trim();
    const h = o.y1 - o.y0;
    const rot = this.alongRot(sd);
    // frame plane sits in the middle of the wall thickness, a bit toward the outside
    const fc = mid - sd.inward * thick * 0.15;
    const [fx, fz] = sd.axis === 'z' ? [o.t, fc] : [fc, o.t];
    k.at(fx, 0, fz, rot, () => {
      // in this frame: local x along the wall, local z = across (sign: +z toward the room if inward>0 on z sides)
      const dir = sd.axis === 'z' ? sd.inward : -sd.inward; // local z toward the room
      const glassM = sd.room.type === 'bathroom' ? M.frosted() : M.glass();
      if (office) {
        // steel loft window: fixed panes with a transom
        k.box(frame, o.w, 0.05, 0.06, 0, o.y0, 0);
        k.box(frame, o.w, 0.05, 0.06, 0, o.y1 - 0.05, 0);
        k.box(frame, o.w, 0.04, 0.05, 0, o.y0 + h * 0.72, 0);
        for (const sx of [-1, 0, 1]) k.box(frame, 0.04, h, 0.06, sx * (hw - 0.02), o.y0, 0);
        k.quad(glassM, o.w, h, 0, o.y0 + h / 2, 0, 0);
      } else {
        // double-hung sash: lower sash inside, upper sash outside, meeting rail in the middle
        const sashH = h / 2 + 0.02;
        const mullions = r.chance(0.4);
        for (const [i, y] of [[0, o.y0], [1, o.y0 + h / 2 - 0.02]] as const) {
          const z = dir * (i === 0 ? 0.025 : -0.025);
          k.box(frame, o.w, 0.06, 0.045, 0, y, z);
          k.box(frame, o.w, 0.05, 0.045, 0, y + sashH - 0.05, z);
          for (const sx of [-1, 1]) k.box(frame, 0.05, sashH, 0.045, sx * (hw - 0.025), y, z);
          if (mullions) k.box(frame, 0.02, sashH, 0.03, 0, y, z);
          k.quad(glassM, o.w - 0.08, sashH - 0.1, 0, y + sashH / 2, z, 0);
        }
        // sash lock
        k.box(M.brass(), 0.08, 0.015, 0.04, 0, o.y0 + h / 2 + 0.02, dir * 0.05);
      }
    });
    // the view across the street: an emissive backdrop outside the wall (bathrooms: frosted glass, daylight only)
    const vseed = hashN(this.desc.seed, Math.round(o.t * 10), Math.round(sd.c * 10)) % 5;
    const view = sd.room.type === 'bathroom' ? M.matte(this.night ? '#1a2238' : '#dfe8ee') : M.emissiveMap(`view${vseed}${this.night}`, windowViewTex(vseed, this.night), this.night ? 0.6 : 1.0);
    view.userData.windowView = true; // weather.ts: overcast / rain / snow / fog in the view
    const out = sd.face - sd.inward * (thick + 1.4);
    const vw = o.w + 2.4, vh = h + 2.0;
    const [vx, vz] = sd.axis === 'z' ? [o.t, out] : [out, o.t];
    k.quad(view, vw, vh, vx, o.y0 + h / 2 + 0.3, vz, this.rotOf(sd));
    // stool (inner sill) and apron
    const sillM = office ? M.matte('#d8d6d0') : M.trim();
    const [sx, sz] = this.at(sd, o.t, -thick / 2 + 0.05);
    if (sd.axis === 'z') k.box(sillM, o.w + 0.24, 0.03, thick + 0.1, sx, o.y0 - 0.03, sz);
    else k.box(sillM, thick + 0.1, 0.03, o.w + 0.24, sx, o.y0 - 0.03, sz);
    if (!office) {
      const [ax, az] = this.at(sd, o.t, 0.01);
      if (sd.axis === 'z') k.box(M.trim(), o.w + 0.1, 0.08, 0.02, ax, o.y0 - 0.11, az);
      else k.box(M.trim(), 0.02, 0.08, o.w + 0.1, ax, o.y0 - 0.11, az);
    }
    // radiator under the window
    if (o.y0 > 0.6) {
      const len = Math.min(o.w + 0.05, 1.1);
      const [rx, rz] = this.at(sd, o.t, 0.14);
      k.at(rx, 0, rz, this.rotOf(sd), () => F.radiator(k, len));
      const fp = footprint(len + 0.2, 0.24, this.rotOf(sd), rx, rz);
      this.cols.push(fp);
    }
    this.treatment(sd, o);
    // a plant or a cup on some sills
    if (!office && r.chance(0.25)) {
      const [px, pz] = this.at(sd, o.t + r.range(-hw * 0.5, hw * 0.5), 0.0);
      k.at(px, o.y0, pz, 0, () => F.plant(k, r, 0.3, true));
    }
  }

  private doorLeaves(splits: Split[], rooms: Room[]) {
    const k = this.kit;
    for (const s of splits) {
      const cands: { sd: Side; dir: 1 | -1 }[] = [];
      for (const rm of rooms)
        for (const sd of this.sides.get(rm)!) {
          if (sd.axis !== s.axis || Math.abs(sd.c - s.c) > 0.01 || !(s.door > sd.e0 && s.door < sd.e1)) continue;
          for (const dir of [1, -1] as const) {
            const h0 = s.door + (dir * DOOR) / 2;
            const h1 = h0 + dir * 0.92;
            if (Math.min(h0, h1) < sd.e0 + 0.05 || Math.max(h0, h1) > sd.e1 - 0.05) continue;
            if (sd.open.some((o) => o.t !== s.door && Math.abs(o.t - (h0 + h1) / 2) < o.w / 2 + 0.5)) continue;
            cands.push({ sd, dir });
          }
        }
      if (!cands.length) continue;
      // doors swing into the more private room
      const rank = (t: string) => ({ bathroom: 0, bedroom: 1, kids: 1, study: 2, office: 2, meeting: 2 } as Record<string, number>)[t] ?? 5;
      cands.sort((p, q) => rank(p.sd.room.type) - rank(q.sd.room.type) || area(p.sd.room) - area(q.sd.room));
      const { sd, dir } = cands[0];
      this.use(sd.room);
      if (sd.room.type === 'meeting' && this.style === 'office') continue;
      const hinge = s.door + (dir * DOOR) / 2;
      const [hx, hz] = this.at(sd, hinge, 0.05);
      // local +x of the leaf runs along the wall away from the opening
      const ax = sd.axis === 'z' ? dir : 0, az = sd.axis === 'z' ? 0 : dir;
      const rot = Math.atan2(-az, ax);
      k.at(hx, 0, hz, rot, () => F.doorLeaf(k, DOOR - 0.08, DOOR_H - 0.02, this.pal.door));
      const a = Math.min(hinge, hinge + dir * 0.92), b = Math.max(hinge, hinge + dir * 0.92);
      sd.used.push({ a: a - 0.05, b: b + 0.05, h: 9 });
      const [cx, cz] = this.at(sd, (a + b) / 2, 0.12);
      this.cols.push(sd.axis === 'z' ? rect(cx, cz, b - a, 0.16) : rect(cx, cz, 0.16, b - a));
      // a marble saddle at bathroom doors
      if (sd.room.type === 'bathroom' || cands.some((c) => c.sd.room.type === 'bathroom')) {
        if (sd.axis === 'z') k.box(M.marble(), DOOR, 0.012, T, s.door, 0, s.c);
        else k.box(M.marble(), T, 0.012, DOOR, s.c, 0, s.door);
      }
    }
  }

  private exitDoor(exitX: number, bounds: { z1: number }) {
    const k = this.kit;
    const z = bounds.z1;
    const paintM = this.style === 'office' ? M.matte('#5a5e62') : M.painted(this.rng.pick(['#3b2a20', '#2f3a40', '#5a2a24', '#7a6a58']));
    // closed leaf in the opening, peephole and deadbolt
    k.at(exitX - (DOOR - 0.04) / 2, 0, z - 0.02, 0, () => F.doorLeaf(k, DOOR - 0.04, DOOR_H - 0.01, paintM));
    k.cyl(M.brass(), 0.012, 0.012, 0.02, exitX, 1.55, z - 0.06, 10);
    k.box(M.brass(), 0.06, 0.06, 0.02, exitX + DOOR / 2 - 0.1, 1.25, z - 0.055);
    k.box(M.matte('#18161a'), DOOR, DOOR_H, 0.02, exitX, 0, z + T / 2 + 0.02);
    const signText = this.desc.floor > 0 ? 'DOWNSTAIRS' : 'EXIT';
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.15), new THREE.MeshBasicMaterial({ map: signTex(signText, '#1a0a0a', '#ff3b30') }));
    sign.userData.owned = true;
    sign.position.set(exitX, DOOR_H + 0.28, z - T / 2 - 0.06);
    sign.rotation.y = Math.PI;
    this.cur.group.add(sign);
    this.cur.group.add(box(mat('#d8d8d8', { rough: 0.6 }), 0.46, 0.19, 0.05, exitX, DOOR_H + 0.185, z - T / 2 - 0.02, false));
    this.cur.group.add(glow('#ff5040', 0.7, exitX, DOOR_H + 0.28, z - T / 2 - 0.15, 0.35));
    this.ports.push({
      box: new THREE.Box3(new THREE.Vector3(exitX - 0.7, 0, z - 0.6), new THREE.Vector3(exitX + 0.7, 2.4, z + 0.3)),
      label: this.desc.floor > 0 ? 'Go back downstairs' : 'Leave the building',
      target: 'back',
    });
  }

  private floorAndCeiling(rm: Room) {
    const k = this.kit;
    const H = this.H;
    const w = rm.x1 - rm.x0, d = rm.z1 - rm.z0;
    const cx = (rm.x0 + rm.x1) / 2, cz = (rm.z0 + rm.z1) / 2;
    const t = rm.type;
    const office = this.style === 'office';
    let fm: THREE.Material;
    if (t === 'bathroom') fm = M.hex();
    else if (t === 'kitchen' || t === 'pantry') fm = this.style === 'house' ? M.checker() : this.rng.chance(0.5) ? M.checker() : M.parquet();
    else if (office && t !== 'pantry') fm = M.carpetTile(t === 'meeting' ? '#5a5048' : '#4a4d52');
    else if (t === 'storage' || t === 'workshop' || t === 'shop') fm = M.matte('#9a958c');
    else fm = M.parquet();
    k.flat(fm, w, d, cx, 0, cz);
    if (office) {
      k.box(M.dropCeiling(), w, 0.02, d, cx, H, cz);
      // 2x4 troffers on the tile grid
      const nx = Math.max(1, Math.floor(w / 2.4)), nz = Math.max(1, Math.floor(d / 2.4));
      for (let i = 0; i < nx; i++)
        for (let j = 0; j < nz; j++) {
          const x = rm.x0 + (w * (i + 0.5)) / nx, z = rm.z0 + (d * (j + 0.5)) / nz;
          k.box(M.matte('#e8e8e6'), 0.62, 0.02, 1.22, x, H - 0.015, z);
          k.box(M.troffer(), 0.56, 0.01, 1.16, x, H - 0.022, z);
        }
      return;
    }
    k.box(M.ceiling(), w, 0.02, d, cx, H, cz);
    k.unshadowed(() => this.fixture(rm, w, d, cx, cz));
  }

  private fixture(rm: Room, w: number, d: number, cx: number, cz: number) {
    const k = this.kit;
    const H = this.H;
    const t = rm.type;
    const r = this.rng;
    if (t === 'kitchen' || t === 'dining') {
      // schoolhouse pendants
      const n = t === 'kitchen' && Math.max(w, d) > 3.5 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const along = n === 1 ? 0 : (i - 0.5) * Math.max(w, d) * 0.4;
        const x = cx + (w > d ? along : 0), z = cz + (w > d ? 0 : along);
        k.cyl(M.brass(), 0.06, 0.06, 0.03, x, H - 0.03, z, 12);
        k.cyl(M.black(), 0.006, 0.006, 0.6, x, H - 0.63, z, 6);
        k.cyl(M.brass(), 0.05, 0.07, 0.06, x, H - 0.69, z, 12);
        k.sphere(M.diffuser(), 0.12, x, H - 0.8, z, 1.1);
      }
    } else if (t === 'living' && r.chance(0.4)) {
      // small chandelier
      k.cyl(M.brass(), 0.1, 0.1, 0.03, cx, H - 0.03, cz, 14);
      k.cyl(M.brass(), 0.01, 0.01, 0.5, cx, H - 0.53, cz, 6);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        k.box(M.brass(), 0.3, 0.012, 0.012, cx + Math.cos(a) * 0.15, H - 0.6, cz + Math.sin(a) * 0.15, -a);
        k.cyl(M.shade(), 0.035, 0.05, 0.09, cx + Math.cos(a) * 0.3, H - 0.6, cz + Math.sin(a) * 0.3, 10, true);
      }
    } else {
      // flush drum with a glowing diffuser
      const rad = t === 'bathroom' ? 0.15 : 0.22;
      k.cyl(M.matte('#efe9dc'), rad, rad, 0.1, cx, H - 0.12, cz, 24);
      k.cyl(M.diffuser(), rad - 0.02, rad - 0.02, 0.01, cx, H - 0.125, cz, 24);
      // plaster medallion in older buildings
      if (this.style === 'house' && t !== 'bathroom') k.cyl(M.trim(), 0.35, 0.38, 0.02, cx, H - 0.02, cz, 32);
    }
  }

  // ------------------------------------------------------------------ furnishing

  private furnish(room: Room, doorZones: Rect[], stairs: boolean) {
    const r = this.rng.fork(hashN(room.x0 * 100, room.z0 * 100));
    const ix0 = room.x0 + T / 2 - 0.001, iz0 = room.z0 + T / 2 - 0.001;
    const ix1 = room.x1 - T / 2 + 0.001, iz1 = room.z1 - T / 2 + 0.001;
    const inner = { minX: ix0, minZ: iz0, maxX: ix1, maxZ: iz1 };
    const occ: Rect[] = doorZones.filter((z) => overlaps(z, inner));
    const ctx: RoomCtx = {
      room,
      r,
      occ,
      inner,
      sides: this.sides.get(room)!,
      free: (fp: Rect, pad = 0.04) => fp.minX >= ix0 && fp.maxX <= ix1 && fp.minZ >= iz0 && fp.maxZ <= iz1 && occ.every((o) => !overlaps(o, fp, pad)),
    };
    // radiators already stand under the windows
    for (const sd of ctx.sides)
      for (const o of sd.open)
        if (o.kind === 'window' && o.y0 > 0.6) {
          const [x, z] = this.at(sd, o.t, 0.14);
          occ.push(footprint(Math.min(o.w + 0.05, 1.1) + 0.2, 0.32, this.rotOf(sd), x, z));
        }
    if (stairs) this.placeStairs(ctx);
    switch (room.type) {
      case 'living':
        this.living(ctx);
        break;
      case 'bedroom':
        this.bedroom(ctx);
        break;
      case 'kitchen':
      case 'pantry':
        this.kitchen(ctx);
        break;
      case 'bathroom':
        this.bathroom(ctx);
        break;
      case 'study':
      case 'office':
        this.study(ctx);
        break;
      case 'dining':
        this.dining(ctx);
        break;
      case 'openplan':
        this.openPlan(ctx);
        break;
      case 'reception':
        this.reception(ctx);
        break;
      case 'meeting':
        this.meeting(ctx);
        break;
      case 'library':
        this.library(ctx);
        break;
      default:
        this.generic(ctx);
    }
  }

  /** place a piece with its back to a side; returns the frame or null */
  private onWall(c: RoomCtx, sd: Side, w: number, d: number, h: number, prefer: number | 'center' | 'any' = 'any', gap = 0.02, pad = 0.04, maxShift = Infinity): Frame | null {
    const lo = sd.e0 + w / 2 + 0.02, hi = sd.e1 - w / 2 - 0.02;
    if (hi < lo) return null;
    const want = prefer === 'center' ? (sd.e0 + sd.e1) / 2 : prefer === 'any' ? c.r.range(lo, hi) : prefer;
    const cands: number[] = [];
    for (let i = 0; i <= 24; i++) cands.push(lo + ((hi - lo) * i) / 24);
    cands.sort((p, q) => Math.abs(p - want) - Math.abs(q - want));
    for (const t of cands) {
      if (Math.abs(t - want) > maxShift) break;
      if (sd.used.some((u) => u.h > 0 && t + w / 2 > u.a && t - w / 2 < u.b && (u.h > 8 || h > 0))) continue;
      const [x, z] = this.at(sd, t, d / 2 + gap);
      const rot = this.rotOf(sd);
      const fp = footprint(w, d, rot, x, z);
      if (!c.free(fp, pad)) continue;
      sd.used.push({ a: t - w / 2, b: t + w / 2, h });
      c.occ.push(fp);
      this.placed.push({ x, z, rot, w, d, room: c.room });
      this.cols.push(shrink(fp, 0.05));
      return { x, z, rot, t } as Frame & { t: number };
    }
    return null;
  }
  /** a piece standing free at x,z, facing rot */
  private freeAt(c: RoomCtx, w: number, d: number, x: number, z: number, rot: number, collide = true, pad = 0.04): Frame | null {
    const fp = footprint(w, d, Math.round(rot / (Math.PI / 2)) * (Math.PI / 2), x, z);
    if (!c.free(fp, pad)) return null;
    c.occ.push(fp);
    if (collide) this.cols.push(shrink(fp, 0.05));
    return { x, z, rot };
  }
  /**
   * A piece that may come from the photoreal library: `id` streams in and replaces the procedural
   * stand-in drawn by `fallback` (also used when the library is unavailable). Library pieces are portals.
   */
  private libPiece(f: Frame, id: string | null, fallback: (k: Kit) => F.Piece | void, y = 0): F.Piece | void {
    if (!id) {
      let out: F.Piece | void = undefined;
      this.kit.at(f.x, y, f.z, f.rot, () => (out = fallback(this.kit)));
      return out;
    }
    const holder = new THREE.Group();
    holder.position.set(f.x, y, f.z);
    holder.rotation.y = f.rot;
    this.cur.group.add(holder);
    const fk = new Kit();
    const out = fallback(fk);
    fk.finish(holder);
    this.lastLib = { holder, loaded: fillHolder(holder, id) };
    const s = LIB[id];
    this.libPortal(id, f, s, y);
    return out;
  }
  /** register a closed compartment of a placed piece; its contents are generated on demand */
  private container(kind: Container['kind'], f: Frame, b: { x: number; y: number; z: number; w: number; h: number; d: number; doors?: 'left' | 'right' | 'pair' }) {
    const c = Math.cos(f.rot), s = Math.sin(f.rot);
    const obj = new THREE.Group();
    // anchor at the front-centre of the base, +z out of the front (lazy.ts convention)
    const fz = b.z + b.d / 2;
    obj.position.set(f.x + b.x * c + fz * s, b.y, f.z - b.x * s + fz * c);
    obj.rotation.y = f.rot;
    obj.name = `container:${kind}`;
    this.cur.group.add(obj);
    const seed = hashN(this.desc.seed, Math.round(obj.position.x * 100), Math.round(obj.position.z * 100), Math.round(b.y * 100));
    const make = () => {
      switch (kind) {
        case 'fridge':
          return fridgeContents(seed, b.w, b.h, b.d);
        case 'cabinet':
          return cabinetContents(seed, b.w, b.h, b.d);
        case 'upper':
          return upperContents(seed, b.w, b.h, b.d);
        case 'closet':
          return closetContents(seed, b.w, b.h, b.d);
        case 'nightstand':
          return drawerContents(seed, b.w, b.h, b.d, 1, 0.3);
        default:
          return drawerContents(seed, b.w, b.h, b.d, 3);
      }
    };
    // contents are built about the compartment's centre: shift them back by half the depth
    const gen = () => {
      const g = new THREE.Group();
      const inner = make();
      inner.position.z = -b.d / 2;
      g.add(inner);
      return g;
    };
    // real doors that swing (fridge, closet): separate meshes hinged at their edge
    const entry: Container = { kind, obj, size: new THREE.Vector3(b.w, b.h, b.d), room: this.cur.room, generate: gen };
    if (b.doors) {
      const leaf = (hingeX: number, w: number, sign: 1 | -1) => {
        const g = new THREE.Group();
        g.position.set(hingeX, 0, 0.012);
        const k = new Kit();
        if (kind === 'fridge') {
          k.box(M.steel(), w, b.h, 0.04, (sign * w) / 2, 0, 0);
          k.box(M.chrome(), 0.025, 0.55, 0.03, sign * (w - 0.06), b.h * 0.45, 0.04);
        } else {
          k.box(M.trim(), w, b.h, 0.022, (sign * w) / 2, 0, 0);
          const fw = 0.065;
          for (const [x, y, ww, hh] of [[w / 2, 0, w, fw], [w / 2, b.h - fw, w, fw], [fw / 2, fw, fw, b.h - 2 * fw], [w - fw / 2, fw, fw, b.h - 2 * fw]] as const) k.box(M.trim(), ww, hh, 0.012, sign * x, y, 0.016);
          k.sphere(M.brass(), 0.025, sign * (w - 0.06), Math.min(1.05, b.h * 0.5), 0.045);
        }
        k.finish(g, true);
        obj.add(g);
        return g;
      };
      if (b.doors === 'pair') {
        const l = leaf(-b.w / 2, b.w / 2 - 0.005, 1), r = leaf(b.w / 2, b.w / 2 - 0.005, -1);
        entry.open = (t: number) => {
          const e = t * t * (3 - 2 * t);
          l.rotation.y = -1.85 * e;
          r.rotation.y = 1.85 * e;
        };
      } else if (b.doors === 'left') entry.door = leaf(-b.w / 2, b.w, 1);
      else {
        const r = leaf(b.w / 2, b.w, -1);
        entry.open = (t: number) => (r.rotation.y = 1.85 * t * t * (3 - 2 * t));
      }
    }
    this.containers.push(entry);
  }

  /**
   * Drawers and cabinet doors as separate meshes registered as containers (lazy.ts): a drawer slides
   * out with its contents, a door swings on its hinge; contents are generated only when opened.
   */
  /** the last library piece placed by libPiece() and its model load (libDrawerSet refits drawers to it) */
  private lastLib: { holder: THREE.Object3D; loaded: Promise<THREE.Object3D | null> } | null = null;

  /**
   * Drawers for a library dresser / nightstand (lazy-furniture.ts): even rows at once; when the model
   * has loaded, refitted to the drawer fronts read from its front face, and given its colour.
   */
  /** library drawers and cupboards hold what the room would keep in them (lazy-furniture.ts fillCompartment) */
  private libFill(entries: Container[], roomType: string) {
    for (const e of entries) {
      const door = !e.drawer;
      const seed = hashN(this.desc.seed, Math.round(e.obj.position.x * 100), Math.round(e.obj.position.z * 100), Math.round(e.obj.position.y * 100));
      const { x: w, y: h, z: d } = e.size;
      e.generate = () => fillCompartment(seed, w - 0.04, h - 0.02, d - 0.02, themeOf(roomType, door));
    }
  }

  private libDrawerSet(f: Frame, kind: 'dresser' | 'nightstand', size: readonly number[], rows: number) {
    let entries = this.movingParts(f, libDrawers(kind, size, rows, this.pal.wood), true);
    this.libFill(entries, this.cur.room.type);
    const lib = this.lastLib, cur = this.cur, wood = this.pal.wood;
    if (!lib) return;
    // the read and cut cost a few ms: done only for pieces you come up to (lazy.ts prepare), once the model is in
    let model: THREE.Object3D | null = null;
    let result: LazyContainer[] | null = null;
    const prepare = Object.assign(() => {
      if (result || !model) return result;
      result = [];
      refit(model);
      return result;
    }, { ready: () => !!model });
    for (const e of entries) e.prepare = prepare;
    lib.loaded.then((m) => (model = m));
    const refit = (model: THREE.Object3D) => {
      if (lib.holder.userData.disposed || this.group.userData.disposed) return;
      // the model's front as a depth grid (one pass over its triangles), the layout read off it
      const t0 = performance.now();
      const front = readFront(model, lib.holder, size);
      const bands = detectDrawers(model, lib.holder, size, kind, front);
      // (for the lab and perf notes)
      const note = { gridMs: +front.ms.toFixed(1), tris: front.meshes.reduce((n, m) => n + (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute('position').count) / 3, 0), bands: bands?.length ?? 0, totalMs: 0, cut: 0 };
      ((globalThis as unknown as { __drawerProbe?: unknown[] }).__drawerProbe ??= []).push(note);
      if (!bands) {
        // no layout: the added drawers stay (drawn only while out), in the model's main colour
        const mat = frontMaterial(model);
        if (mat) for (const e of entries) e.drawer?.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.material === wood) m.material = mat; });
        return;
      }
      for (const e of entries) {
        e.obj.removeFromParent();
        e.obj.traverse((o) => (o.userData.disposed = true));
        const i = this.containers.indexOf(e);
        if (i >= 0) this.containers.splice(i, 1);
      }
      // the paint of each front (sampled low and off-centre: not the knob), before the fronts are cut out
      // four spots per front (off the centre line, where the knob is), the upper median by brightness:
      // one dark texel or a shadow baked into the texture must not paint the whole door
      const paints = bands.map((b) => {
        const ms = [[-0.3, 0.25], [0.3, 0.25], [-0.3, 0.75], [0.3, 0.75]].map(([fx, fy]) => frontSampleAt(front, b.x + b.w * fx, b.y + b.h * fy)).filter((m) => !!m);
        ms.sort((x, y) => x.lum - y.lum);
        return ms[Math.min(ms.length - 1, Math.floor(ms.length / 2))] ?? null;
      });
      // cut the fronts out of the model, and put real drawers / doors and compartments in the holes
      const cut = cutOpenings(front, bands);
      const prev = this.cur;
      this.cur = cur;
      const d = Math.max(0.15, size[2] - 0.12);
      const zf = (bands[0].z ?? front.zf) + 0.002;
      entries = this.movingParts(
        f,
        bands.map((b) => (b.move === 'door'
          ? { move: 'door' as const, kind: 'cabinet' as const, hinge: b.hinge, x: b.x, y: b.y, z: zf, w: b.w, h: b.h, d, mat: wood }
          : { move: 'drawer' as const, kind, x: b.x, y: b.y, z: zf, w: b.w, h: b.h, d, mat: wood })),
      );
      this.cur = prev;
      for (const e of entries) e.obj.add(compartment(e.size.x + 0.012, e.size.y + 0.006, e.size.z + 0.03));
      this.libFill(entries, cur.room.type);
      if (this.group.userData.containersAdopted) {
        for (const e of entries) {
          this.containers.splice(this.containers.indexOf(e), 1);
          const lc = adoptContainer(e);
          if (lc) result!.push(lc);
        }
      }
      // fronts and doors in the paint of the model's own front there
      // (the model's own material, every uv on that texel: the same paint, lit the same way)
      entries.forEach((e, i) => {
        const p = paints[i], mover = e.drawer ?? e.door;
        if (p && mover) paintWith(mover, wood, p);
      });
      note.totalMs = +(performance.now() - t0).toFixed(1);
      note.cut = cut;
    };
  }

  private movingParts(f: Frame, parts: F.Part[] | undefined, hideClosed = false): Container[] {
    const made: Container[] = [];
    if (!parts) return made;
    const c = Math.cos(f.rot), s = Math.sin(f.rot);
    for (const pt of parts) {
      const obj = new THREE.Group();
      obj.position.set(f.x + pt.x * c + pt.z * s, pt.y, f.z - pt.x * s + pt.z * c);
      obj.rotation.y = f.rot;
      obj.name = `container:${pt.kind}`;
      this.cur.group.add(obj);
      const seed = hashN(this.desc.seed, Math.round(obj.position.x * 100), Math.round(obj.position.z * 100), Math.round(pt.y * 100));
      const k = new Kit();
      const mover = new THREE.Group();
      let open: ((t: number) => void) | undefined;
      if (pt.move === 'drawer') {
        // front with a pull, and the drawer box behind it
        k.box(pt.mat, pt.w, pt.h, 0.02, 0, 0, -0.01);
        if (pt.w > 0.6) for (const sx of [-1, 1]) k.box(M.brass(), 0.1, 0.014, 0.018, sx * pt.w * 0.25, pt.h / 2, 0.008);
        else k.sphere(M.brass(), 0.016, 0, pt.h / 2, 0.012);
        const inner = M.matte('#d9cdb8');
        k.box(inner, pt.w - 0.04, 0.01, pt.d - 0.04, 0, 0.02, -0.02 - (pt.d - 0.04) / 2);
        for (const sx of [-1, 1]) k.box(inner, 0.012, pt.h - 0.04, pt.d - 0.04, sx * (pt.w / 2 - 0.026), 0.02, -0.02 - (pt.d - 0.04) / 2);
        k.box(inner, pt.w - 0.04, pt.h - 0.04, 0.012, 0, 0.02, -pt.d + 0.026);
      } else {
        // a shaker door hinged at one edge; local +x runs from the hinge across the door
        const sign = pt.hinge === 'right' ? -1 : 1;
        mover.position.set((-sign * pt.w) / 2, 0, 0);
        k.at((sign * pt.w) / 2, 0, 0, 0, () => F.shaker(k, pt.mat, pt.w, pt.h, 0, 0, 0));
        k.box(M.brass(), 0.012, 0.11, 0.02, sign * (pt.w - 0.045), pt.kind === 'upper' ? 0.05 : pt.h - 0.16, 0.03);
        open = (t: number) => (mover.rotation.y = -sign * 1.85 * t);
      }
      k.finish(mover, true);
      obj.add(mover);
      const gen = () => {
        const g = new THREE.Group();
        const inner =
          pt.kind === 'cabinet' ? cabinetContents(seed, pt.w, pt.h, pt.d) : pt.kind === 'upper' ? upperContents(seed, pt.w, pt.h, pt.d) : drawerContents(seed, pt.w - 0.06, pt.h, pt.d - 0.02, 1, 0.03);
        inner.position.z = -pt.d / 2 - 0.01;
        g.add(inner);
        return g;
      };
      const entry: Container = { kind: pt.kind, obj, size: new THREE.Vector3(pt.w, pt.h, pt.d), room: this.cur.room, generate: gen };
      if (pt.move === 'drawer') entry.drawer = mover;
      else {
        // a door: our open() swings it (lazy.ts uses `door` only to show / hide it)
        entry.open = open;
        entry.door = mover;
      }
      if (hideClosed) {
        entry.hideClosed = true;
        mover.visible = false;
        // the model's own closed front stays behind a pulled-out drawer: cover it with an empty slot
        entry.slot = slotMesh(pt.w, pt.h);
        entry.slot.position.z = -0.003;
        obj.add(entry.slot);
      }
      this.containers.push(entry);
      made.push(entry);
    }
    return made;
  }

  /** a small library object (no stand-in) */
  private libDecor(id: string, x: number, y: number, z: number, rot: number) {
    const holder = new THREE.Group();
    holder.position.set(x, y, z);
    holder.rotation.y = rot;
    this.cur.group.add(holder);
    void fillHolder(holder, id);
    this.libPortal(id, { x, z, rot }, LIB[id], y);
  }
  private libPortal(id: string, f: Frame, s: [number, number, number], y: number) {
    const q = Math.round(f.rot / (Math.PI / 2)) & 1;
    const w = q ? s[2] : s[0], d = q ? s[0] : s[2];
    const title = id.replace(/_0?\d+$/, '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    const rng = new Rng(hashN(this.desc.seed, f.x * 1000, f.z * 1000, y * 1000));
    const name = `Inside the ${title}`;
    this.ports.push({
      box: new THREE.Box3(new THREE.Vector3(f.x - w / 2 - 0.03, y, f.z - d / 2 - 0.03), new THREE.Vector3(f.x + w / 2 + 0.03, y + s[1] + 0.03, f.z + d / 2 + 0.03)),
      label: `Shrink into the ${title}`,
      sub: 'Poly Haven · CC0',
      target: { kind: 'city', seed: rng.int(0, 2 ** 31), biome: rng.pick(ROLE_BIOMES.painting), name },
      shrink: Math.max(...s),
    });
  }
  /** set 1..n library objects from `set` on a top (a placed piece's local top) */
  private libTop(r: Rng, f: Frame, t: F.Top, set: string, n: number, maxH = 0.6) {
    const fp = this.topRect(f, t);
    const used: Rect[] = [];
    for (let i = 0; i < n; i++) {
      const id = pickLib(set, r, (s) => s[1] <= maxH && Math.max(s[0], s[2]) <= Math.min(fp.maxX - fp.minX, fp.maxZ - fp.minZ) + 0.05);
      if (!id) return;
      const s = LIB[id];
      for (let k = 0; k < 10; k++) {
        const hw = Math.max(s[0], s[2]) / 2;
        if (fp.maxX - fp.minX < 2 * hw || fp.maxZ - fp.minZ < 2 * hw) break;
        const x = r.range(fp.minX + hw, fp.maxX - hw), z = r.range(fp.minZ + hw, fp.maxZ - hw);
        const me = rect(x, z, 2 * hw, 2 * hw);
        if (used.some((u) => overlaps(u, me, 0.02))) continue;
        used.push(me);
        this.libDecor(id, x, t.y, z, f.rot + r.range(-0.4, 0.4));
        break;
      }
    }
  }

  private draw(f: Frame, fn: () => F.Piece | void): F.Piece | void {
    let out: F.Piece | void = undefined;
    this.kit.at(f.x, 0, f.z, f.rot, () => (out = fn()));
    return out;
  }
  /** world rect of a local top on a piece placed at frame f */
  private topRect(f: Frame, t: F.Top): Rect {
    const c = Math.cos(f.rot), s = Math.sin(f.rot);
    const x = f.x + t.x * c + t.z * s, z = f.z - t.x * s + t.z * c;
    return footprint(t.w, t.d, Math.round(f.rot / (Math.PI / 2)) * (Math.PI / 2), x, z);
  }
  private sidesByFreeLength(c: RoomCtx, minLen: number) {
    return [...c.sides]
      .map((sd) => ({ sd, len: freeRun(sd), wins: sd.open.filter((o) => o.kind === 'window').length }))
      .filter((s) => s.len >= minLen)
      .sort((a, b) => b.len - a.len);
  }

  private living(c: RoomCtx) {
    const r = c.r, k = this.kit;
    const w = c.inner.maxX - c.inner.minX, d = c.inner.maxZ - c.inner.minZ;
    // the focal wall: a fireplace (brownstones, some pre-war) or the TV; prefer a solid wall
    const solid = this.sidesByFreeLength(c, 1.9);
    if (!solid.length) return this.generic(c);
    const fireplace = this.style === 'house' || r.chance(0.35);
    const focal = solid.sort((a, b) => a.wins - b.wins || b.len - a.len)[0].sd;
    let ff: Frame | null = null;
    if (fireplace) {
      ff = this.onWall(c, focal, 1.75, 0.75, 2.4, midFree(focal), 0);
      if (ff) {
        const p = this.draw(ff, () => F.fireplace(k, r, r.chance(0.5))) as F.Piece;
        for (const t of p.tops) {
          this.decorateTop(r, ff, { ...t, w: t.w * 0.3 }, ['tableware', 'toy', 'stationery'], [1, 1], 0.4);
          for (const sx of [-1, 1]) this.libTop(r, ff, { ...t, x: sx * t.w * 0.33, w: t.w * 0.3 }, 'mantel', 1, 0.55);
        }
        // built-in bookcases either side of the chimney breast (as in the references)
        const tf = (ff as Frame & { t: number }).t;
        for (const sgn of [-1, 1]) {
          const bw = 0.9;
          const t = tf + sgn * (0.9 + 0.12 + bw / 2);
          const bf = this.onWall(c, focal, bw, 0.36, 2.1, t, 0.0, 0.0);
          if (bf && Math.abs((bf as Frame & { t: number }).t - t) < 0.05) {
            const bp = this.draw(bf, () => F.bookcase(k, r, bw, 2.1, M.trim(), r.int(0, 9))) as F.Piece;
            for (const tp of bp.tops.slice(0, -1)) this.decorateTop(r, bf, tp, ['tableware', 'toy', 'stationery'], [1, 1], 0.28);
          }
        }
      }
    }
    if (!ff) {
      ff = this.onWall(c, focal, 1.8, 0.45, 1.3, midFree(focal), 0.02);
      if (ff) {
        const p = this.draw(ff, () => F.tvConsole(k, r, this.pal.wood)) as F.Piece;
        for (const t of p.tops) this.decorateTop(r, ff, t, ['electronics', 'plant', 'tableware', 'toy'], [1, 1], 0.35);
      }
    }
    if (!ff) return this.generic(c);
    // sofa facing the focal wall: against the opposite wall if the room is shallow enough, else floating
    const opp = c.sides.find((s) => s.axis === focal.axis && s.inward === -focal.inward)!;
    const across = Math.abs(opp.face - focal.face);
    const span = focal.axis === 'z' ? w : d;
    const sofaId = span < 4.6 && r.chance(0.5) ? pickLib('sofa', r) : null;
    const sofaW = sofaId ? LIB[sofaId][0] : THREE.MathUtils.clamp(span * 0.5, 2.0, 2.5);
    const sofaD = sofaId ? LIB[sofaId][2] : 0.92;
    const tf = (ff as Frame & { t: number }).t ?? (focal.e0 + focal.e1) / 2;
    let sf: Frame | null = null;
    const dist = Math.min(across - sofaD, 3.6);
    if (across < 4.8) sf = this.onWall(c, opp, sofaW, sofaD, 0.85, tf, 0.03, 0.04, 0.25);
    if (!sf) {
      const [x, z] = this.at(focal, tf, dist + sofaD / 2);
      sf = this.freeAt(c, sofaW, sofaD, x, z, this.rotOf(focal) + Math.PI);
    }
    if (!sf) return this.generic(c);
    this.libPiece(sf, sofaId, (kk) => F.sofa(kk, r, sofaW, this.pal.fabric, this.pal.metal === M.brass() ? M.walnut() : M.black(), this.pal.accent));
    // positions in the focal frame: depth from the focal wall
    const sofaDepth = Math.abs((focal.axis === 'z' ? sf.z : sf.x) - focal.face) - sofaD / 2;
    const ctDepth = sofaDepth - 0.45 - 0.3;
    const mid = (0.75 + sofaDepth) / 2;
    // rug under the front legs of the group
    const rugW = Math.min(sofaW + 1.6, span - 0.5);
    const rugD = Math.min(sofaDepth - 0.3, 3.2);
    if (rugD > 1.4) {
      const [x, z] = this.at(focal, tf, 0.5 + rugD / 2 + Math.max(0, sofaDepth - 0.2 - rugD - 0.5));
      // layered: a big jute rug under the patterned one
      if (r.chance(0.6)) k.flat(M.carpet('#b9a684'), Math.min(rugW + 0.5, span - 0.3), rugD + 0.45, x, 0.005, z, 'world', [1, 1], this.rotOf(focal));
      k.flat(M.mapped(`rug${this.desc.seed % 9}`, rugTex(hashN(this.desc.seed, room2n(c.room)) % 40)), rugW, rugD, x, 0.008, z, 'keep', [1, 1], this.rotOf(focal) + (focal.axis === 'z' ? 0 : 0));
    }
    // coffee table
    {
      const [x, z] = this.at(focal, tf, Math.max(ctDepth, mid));
      const ctId = r.chance(0.5) ? pickLib('coffee', r) : null;
      const cs = ctId ? LIB[ctId] : [1.1, 0.43, 0.62];
      const f = this.freeAt(c, cs[0], cs[2], x, z, this.rotOf(focal), true, 0.02);
      if (f) {
        const pp = this.libPiece(f, ctId, (kk) => F.coffeeTable(kk, r, this.pal.wood, M.brass(), M.marble())) as F.Piece;
        const top = ctId ? { x: 0, z: 0, y: cs[1], w: cs[0] * 0.8, d: cs[2] * 0.7 } : pp.tops[0];
        this.kit.at(f.x, 0, f.z, f.rot, () => {
          F.bookStack(k, r, top.w * 0.25, top.y, 0);
          if (r.chance(0.5)) F.mug(k, r, -top.w * 0.2, top.y, top.d * 0.2);
        });
        if (r.chance(0.5)) this.decorateTop(r, f, { ...top, x: -top.w * 0.2, w: top.w * 0.45 }, ['tableware', 'food', 'toy', 'plant'], [1, 1], 0.3);
        else this.libTop(r, f, { ...top, x: -top.w * 0.2, w: top.w * 0.45 }, 'table', 1, 0.45);
      }
    }
    // armchairs at the sides of the group, turned toward the middle
    for (const sgn of [-1, 1]) {
      if (!r.chance(0.75)) continue;
      const [x, z] = this.at(focal, tf + sgn * (sofaW / 2 + 0.75), mid);
      const toward = this.rotOf(focal) + Math.PI + sgn * (focal.axis === 'z' ? 1 : 1) * (Math.PI / 2) * (focal.inward > 0 === (focal.axis === 'z') ? -1 : 1);
      const acId = r.chance(0.6) ? pickLib('armchair', r) : null;
      const f = this.freeAt(c, 0.9, 0.9, x, z, Math.round(toward / (Math.PI / 2)) * (Math.PI / 2));
      if (f) this.libPiece({ ...f, rot: Math.atan2(this.at(focal, tf, mid)[0] - x, this.at(focal, tf, mid)[1] - z) }, acId, (kk) => F.armchair(kk, r.chance(0.5) ? this.pal.accent[0] : this.pal.fabric, M.walnut()));
    }
    // end tables with lamps at the sofa arms
    for (const sgn of [-1, 1]) {
      const along = sf.rot; // sofa faces focal
      const c0 = Math.cos(along), s0 = Math.sin(along);
      const lx = sgn * (sofaW / 2 + 0.28);
      const x = sf.x + lx * c0, z = sf.z - lx * s0;
      const f = this.freeAt(c, 0.45, 0.45, x, z, sf.rot, true, 0.0);
      if (!f) continue;
      const stId = r.chance(0.5) ? 'side_table_01' : null;
      const p = this.libPiece(f, stId, (kk) => F.sideTable(kk, this.pal.wood)) as F.Piece;
      const ph = stId ? LIB[stId][1] : p.h;
      this.kit.at(f.x, 0, f.z, 0, () => F.tableLamp(k, r, 0, ph, 0));
      p.h = ph;
      this.cur.group.add(glow('#ffd59a', 0.55, f.x, p.h + 0.4, f.z, 0.3));
    }
    // a painting over the sofa (if it stands against a wall)
    const sofaSide = c.sides.find((s) => Math.abs((s.axis === 'z' ? sf!.z : sf!.x) - (s.face + s.inward * 0.49)) < 0.1 && s.axis === opp.axis);
    if (sofaSide) this.painting(r, sofaSide, (sofaSide.axis === 'z' ? sf.x : sf.z), 1.75, Math.min(1.3, sofaW * 0.6));
    // floor lamp, bookcase, plants
    this.corners(c, 'floorlamp', 1);
    for (const s of this.sidesByFreeLength(c, 1.1).slice(0, 2)) {
      const f = this.onWall(c, s.sd, 1.0, 0.34, 2.0);
      if (f) {
        const p = this.draw(f, () => F.bookcase(k, r, 1.0, 2.0, this.pal.wood, r.int(0, 9))) as F.Piece;
        for (const tp of p.tops.slice(0, -1)) this.decorateTop(r, f, tp, ['tableware', 'toy', 'stationery', 'plant'], [1, 1], 0.28);
        break;
      }
    }
    this.consoleGroup(c);
    this.accentChair(c);
    this.galleryWall(c);
    if (Math.max(w, d) > 6) this.corners(c, 'armchair', 1);
    this.corners(c, 'plant', r.int(1, 2));
    // a dining table in the other half of a long living room
    if (Math.max(w, d) > 6.5) this.diningGroup(c, 4);
    this.paintings(c, r.int(1, 2));
  }

  private bedroom(c: RoomCtx) {
    const r = c.r, k = this.kit;
    // brownstones: sometimes the carved Poly Haven bed (1.49 x 2.04)
    const bedId = this.style === 'house' && r.chance(0.4) ? 'GothicBed_01' : null;
    const bw = bedId ? 1.38 : area(c.room) > 14 ? 1.6 : 1.4;
    // headboard against the wall with the longest free run, centred on it
    let bf: (Frame & { t: number }) | null = null;
    let bside: Side | null = null;
    for (const s of this.sidesByFreeLength(c, bw + 0.3)) {
      const f = this.onWall(c, s.sd, bw + 0.12, 2.16, 1.15, midFree(s.sd), 0.0, 0.3) as (Frame & { t: number }) | null;
      if (f) {
        bf = f;
        bside = s.sd;
        break;
      }
    }
    if (!bf || !bside) return this.generic(c);
    const linen = M.fabric(r.pick(['#f4f2ec', '#e9e6df', '#dfe4e8']));
    const duvet = M.fabric(r.pick(['#f1efe9', '#d9dde3', '#cfc6b6', '#8a96a3', '#b9a99a']));
    const head = r.chance(0.5) ? M.velvet(r.pick(['#3d4a5c', '#7a6a58', '#5a6b5a', '#8a5a4a'])) : this.pal.wood;
    // rug first so it sits under the bed
    {
      const [x, z] = this.at(bside, bf.t, 1.35);
      k.flat(M.mapped(`rugb${this.desc.seed % 7}`, rugTex(hashN(this.desc.seed, 77, room2n(c.room)) % 40)), bw + 1.2, 2.0, x, 0.008, z, 'keep', [1, 1], this.rotOf(bside));
    }
    this.libPiece(bf, bedId, (kk) => F.bed(kk, r, bw, this.pal.wood, linen, duvet, r.pick(this.pal.accent), head));
    // nightstands with lamps
    for (const sgn of [-1, 1]) {
      const t = bf.t + sgn * ((bw + 0.12) / 2 + 0.3);
      const f = this.onWall(c, bside, 0.5, 0.4, 0.58, t, 0.02, 0.0) as (Frame & { t: number }) | null;
      if (!f || Math.abs(f.t - t) > 0.1) continue;
      const nsId = r.chance(0.5) ? pickLib('nightstand', r) : null;
      const p = this.libPiece(f, nsId, (kk) => F.nightstand(kk, this.pal.wood)) as F.Piece;
      if (nsId) p.h = LIB[nsId][1];
      if (nsId) this.libDrawerSet(f, 'nightstand', LIB[nsId], 1);
      else this.movingParts(f, p.parts);
      this.kit.at(f.x, 0, f.z, f.rot, () => {
        F.tableLamp(k, r, -0.08, p.h, -0.04);
        if (r.chance(0.6)) F.bookStack(k, r, 0.12, p.h, 0.05);
      });
      this.cur.group.add(glow('#ffd59a', 0.5, f.x, p.h + 0.4, f.z, 0.3));
    }
    this.painting(r, bside, bf.t, 1.15 + 0.35 + 0.4, Math.min(1.2, bw * 0.75));
    // a built-in closet
    for (const s of this.sidesByFreeLength(c, 1.3)) {
      if (s.sd === bside) continue;
      const cw = Math.min(1.6, freeRun(s.sd) - 0.1);
      const f = this.onWall(c, s.sd, cw, 0.62, 2.3, r.chance(0.5) ? s.sd.e0 + cw / 2 + 0.02 : s.sd.e1 - cw / 2 - 0.02, 0.0, 0.02);
      if (!f) continue;
      const p = this.draw(f, () => F.closet(k, cw, Math.min(2.3, this.H - 0.3), M.trim())) as F.Piece;
      for (const b of p.boxes ?? []) this.container('closet', f, b);
      break;
    }
    // dresser on another wall, a picture or mirror over it
    for (const s of this.sidesByFreeLength(c, 1.2)) {
      if (s.sd === bside) continue;
      const drId = r.chance(0.5) ? pickLib('dresser', r) : null;
      const ds = drId ? LIB[drId] : [1.2, 0.86, 0.5];
      const f = this.onWall(c, s.sd, ds[0], ds[2], ds[1], 'any', 0.02) as (Frame & { t: number }) | null;
      if (!f) continue;
      const p = this.libPiece(f, drId, (kk) => F.dresser(kk, r, this.pal.wood)) as F.Piece;
      const dtop = drId ? { x: 0, z: 0, y: ds[1], w: ds[0] - 0.1, d: ds[2] - 0.12 } : p.tops[0];
      if (drId) this.libDrawerSet(f, 'dresser', ds, ds[1] > 1.1 ? 4 : 3);
      else this.movingParts(f, p.parts);
      this.decorateTop(r, f, { ...dtop, x: -dtop.w / 4, w: dtop.w / 2 }, ['lamp', 'tableware', 'toy', 'plant', 'electronics'], [1, 1], 0.45);
      this.libTop(r, f, { ...dtop, x: dtop.w / 4, w: dtop.w / 2 }, 'table', 2, 0.45);
      if (r.chance(0.6)) {
        const [mx, mz] = this.at(s.sd, f.t, 0.0);
        this.kit.at(mx, 0, mz, this.rotOf(s.sd), () => {
          k.box(M.brass(), 0.7, 0.9, 0.03, 0, 1.15, 0.015);
          k.box(M.mirror(), 0.64, 0.84, 0.005, 0, 1.18, 0.032);
        });
        s.sd.used.push({ a: f.t - 0.4, b: f.t + 0.4, h: 9 });
      }
      break;
    }
    // reading chair and lamp in a corner
    if (area(c.room) > 11) this.corners(c, 'armchair', 1);
    this.corners(c, 'plant', r.int(0, 1));
    this.paintings(c, r.int(0, 1));
  }

  private kitchen(c: RoomCtx) {
    const r = c.r, k = this.kit;
    const w = c.inner.maxX - c.inner.minX, d = c.inner.maxZ - c.inner.minZ;
    const narrow = Math.min(w, d);
    // run along the longest wall with the fewest windows
    const cand = [...c.sides].map((sd) => ({ sd, len: freeRun(sd), wins: sd.open.filter((o) => o.kind === 'window').length })).filter((s) => s.len >= 1.6);
    cand.sort((a, b) => a.wins - b.wins || b.len - a.len);
    if (!cand.length) return this.generic(c);
    const runs = narrow < 3.3 && narrow > 2.3 ? 2 : 1;
    // marble counters (and often a marble slab backsplash) in apartments and brownstones
    const kcounter = this.style === 'office' ? this.pal.counter : r.chance(0.8) ? M.marble('#ffffff') : M.marble('#6a6a6a');
    const ksplash = this.style !== 'office' && r.chance(0.4) ? kcounter : M.subway(r.pick(['#f4f2ec', '#f4f2ec', '#e3ebe6', '#1f2a33']));
    const used: Side[] = [];
    const runFrames: Frame[] = [];
    for (const s of cand) {
      if (used.length >= runs) break;
      if (used.length && !(s.sd.axis === used[0].axis && s.sd.inward === -used[0].inward)) continue;
      const [lo, hi] = longestFree(s.sd);
      const len = Math.min(hi - lo - 0.04, 4.6);
      if (len < 1.6) continue;
      const t = (lo + hi) / 2;
      const f = this.onWall(c, s.sd, len, 0.64, 2.3, t, 0.0, 0.0) as (Frame & { t: number }) | null;
      if (!f) continue;
      const hasWin = s.wins > 0;
      const p = this.draw(f, () =>
        F.kitchenRun(k, r, {
          len,
          cab: this.pal.cab,
          counter: kcounter,
          splash: ksplash,
          fridgeAt: used.length ? 0 : r.chance(0.5) ? -1 : 1,
          rangeAt: used.length ? 0.5 : r.range(0.3, 0.7),
          sinkAt: r.range(0.2, 0.8),
          uppers: !hasWin,
          ceilingH: this.H,
        }),
      ) as F.Piece;
      for (const tp of p.tops) {
        this.decorateTop(r, f, { ...tp, w: tp.w / 2, x: tp.x - tp.w / 4 }, ['tableware', 'food', 'appliance', 'tableware'], [1, 1], 0.45);
        this.libTop(r, f, { ...tp, w: tp.w / 2, x: tp.x + tp.w / 4 }, 'kitchen', 2, 0.4);
      }
      for (const tp of p.tops) if (r.chance(0.5)) this.kit.at(f.x, 0, f.z, f.rot, () => F.bowl(k, r, tp.x + tp.w * 0.3, tp.y, tp.z));
      for (const b of p.boxes ?? []) this.container(b.kind as Container['kind'], f, b);
      this.movingParts(f, p.parts);
      used.push(s.sd);
      runFrames.push(f);
    }
    // an island with stools when the kitchen is wide enough, else a small table
    if (!(used.length === 1 && narrow >= 3.6 && this.island(c, used[0], runFrames[0], kcounter))) this.diningGroup(c, 2);
    this.corners(c, 'plant', r.int(0, 1));
    this.paintings(c, r.int(0, 1));
  }

  private island(c: RoomCtx, run: Side, rf: Frame, counter: THREE.Material): boolean {
    const r = c.r, k = this.kit;
    const [lo, hi] = [run.e0, run.e1];
    const iw = Math.min(2.2, hi - lo - 1.4), idp = 0.95;
    if (iw < 1.2) return false;
    const t = (run.axis === 'z' ? rf.x : rf.z);
    const [x, z] = this.at(run, t, 0.64 + 1.05 + idp / 2);
    const f = this.freeAt(c, run.axis === 'z' ? iw : idp, run.axis === 'z' ? idp : iw, x, z, 0, true, 0.02);
    if (!f) return false;
    // stools on the far side need room
    const [sx, sz] = this.at(run, t, 0.64 + 1.05 + idp + 0.35);
    if (!c.free(rect(sx, sz, run.axis === 'z' ? iw : 0.6, run.axis === 'z' ? 0.6 : iw), 0.0)) return false;
    c.occ.push(rect(sx, sz, run.axis === 'z' ? iw : 0.6, run.axis === 'z' ? 0.6 : iw));
    const rot = this.rotOf(run) + Math.PI; // island cabinets face the run
    const fr = { x, z, rot };
    this.kit.at(x, 0, z, rot, () => {
      k.box(M.matte('#2a2724'), iw - 0.1, 0.1, idp - 0.38, 0, 0, 0.1);
      k.box(this.pal.cab, iw - 0.04, 0.785, idp - 0.3, 0, 0.1, 0.13);
      k.box(counter, iw + 0.04, 0.04, idp, 0, 0.885, 0);
      const n = Math.max(2, Math.round(iw / 0.5));
      for (let i = 0; i < n; i++) {
        const xx = -iw / 2 + 0.02 + ((iw - 0.04) * (i + 0.5)) / n;
        k.box(this.pal.cab, (iw - 0.04) / n - 0.006, 0.16, 0.02, xx, 0.69, idp / 2 - 0.01);
        k.box(this.pal.cab, (iw - 0.04) / n - 0.006, 0.54, 0.02, xx, 0.12, idp / 2 - 0.01);
        k.box(this.pal.cab, (iw - 0.04) / n - 0.13, 0.42, 0.02, xx, 0.18, idp / 2 + 0.005);
        k.box(M.brass(), 0.12, 0.012, 0.02, xx, 0.77, idp / 2 + 0.015);
      }
    });
    this.container('cabinet', fr, { x: 0, y: 0.1, z: 0.13, w: iw - 0.04, h: 0.6, d: idp - 0.34 });
    // stools
    const n = Math.max(2, Math.floor(iw / 0.6));
    const c0 = Math.cos(rot), s0 = Math.sin(rot);
    for (let i = 0; i < n; i++) {
      const lx = -iw / 2 + (iw * (i + 0.5)) / n;
      const lz = -idp / 2 - 0.3;
      const px = x + lx * c0 + lz * s0, pz = z - lx * s0 + lz * c0;
      const id = pickLib('stool', r);
      this.libPiece({ x: px, z: pz, rot: rot + Math.PI + r.range(-0.15, 0.15) }, id, (kk) => {
        kk.cyl(M.black(), 0.02, 0.02, 0.62, 0, 0, 0, 8);
        kk.cyl(M.black(), 0.2, 0.22, 0.02, 0, 0, 0, 16);
        kk.cyl(this.pal.wood, 0.19, 0.19, 0.05, 0, 0.62, 0, 18);
      });
    }
    this.libTop(r, fr, { x: 0, z: 0, y: 0.925, w: iw - 0.3, d: idp - 0.3 }, 'kitchen', 2, 0.4);
    if (r.chance(0.5)) this.kit.at(x, 0.925, z, 0, () => F.vase(k, r, 0, 0, 0));
    return true;
  }

  private dining(c: RoomCtx) {
    const r = c.r, k = this.kit;
    this.diningGroup(c, 6);
    this.galleryWall(c);
    for (const s of this.sidesByFreeLength(c, 1.5)) {
      const f = this.onWall(c, s.sd, 1.5, 0.48, 0.86, midFree(s.sd), 0.02) as (Frame & { t: number }) | null;
      if (!f) continue;
      const p = this.draw(f, () => F.dresser(k, r, this.pal.wood)) as F.Piece;
      this.decorateTop(r, f, p.tops[0], ['tableware', 'food', 'tableware', 'lamp'], [2, 3], 0.4);
      this.painting(r, s.sd, f.t, 1.85, 1.1);
      break;
    }
    this.corners(c, 'plant', r.int(1, 2));
    this.paintings(c, r.int(1, 2));
  }

  /** a table with chairs centred in the free part of the room */
  private diningGroup(c: RoomCtx, seats: number) {
    const r = c.r, k = this.kit;
    const w = c.inner.maxX - c.inner.minX, d = c.inner.maxZ - c.inner.minZ;
    const long = w > d;
    const tw = seats > 4 ? 1.8 : seats > 2 ? 1.4 : 0.9, td = seats > 2 ? 0.9 : 0.75;
    const cw = long ? tw : td, cd = long ? td : tw;
    // search the room for a spot with chair clearance
    const pts: [number, number][] = [];
    for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) pts.push([c.inner.minX + (w * i) / 6, c.inner.minZ + (d * j) / 6]);
    const cx = (c.inner.minX + c.inner.maxX) / 2, cz = (c.inner.minZ + c.inner.maxZ) / 2;
    pts.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cz) - Math.hypot(b[0] - cx, b[1] - cz));
    for (const [x, z] of pts) {
      const clear = rect(x, z, cw + 1.1, cd + 1.1);
      if (!c.free(clear, 0.02)) continue;
      const f = this.freeAt(c, cw, cd, x, z, 0);
      if (!f) continue;
      const wood = r.chance(0.5) ? this.pal.wood : M.walnut();
      const p = this.draw({ x, z, rot: long ? 0 : Math.PI / 2 }, () => F.diningTable(k, r, tw, td, wood)) as F.Piece;
      c.occ.push(clear);
      // chairs: along the long sides, plus the ends for big tables
      const spots: [number, number, number][] = [];
      const per = seats > 4 ? 2 : 1;
      for (let i = 0; i < per; i++) {
        const lx = per === 1 ? 0 : (i - 0.5) * tw * 0.5;
        spots.push([lx, td / 2 + 0.12, Math.PI], [lx, -td / 2 - 0.12, 0]);
      }
      if (seats >= 6) spots.push([tw / 2 + 0.12, 0, -Math.PI / 2], [-tw / 2 - 0.12, 0, Math.PI / 2]);
      const seat = r.chance(0.5) ? r.pick(this.pal.accent) : null;
      const trot = long ? 0 : Math.PI / 2;
      const c0 = Math.cos(trot), s0 = Math.sin(trot);
      const chairId = r.chance(0.6) ? pickLib('diningchair', r) : null;
      for (const [lx0, lz0, rot] of spots.slice(0, Math.max(seats, 2))) {
        const lx = lx0 + r.range(-0.03, 0.03), lz = lz0 + r.range(0, 0.08) * Math.sign(lz0 || 1);
        this.libPiece({ x: x + lx * c0 + lz * s0, z: z - lx * s0 + lz * c0, rot: trot + rot + r.range(-0.08, 0.08) }, chairId, (kk) => F.diningChair(kk, wood, seat));
      }
      this.kit.at(x, 0, z, trot, () => F.vase(k, r, 0, p.h, 0));
      this.decorateTop(r, { x, z, rot: long ? 0 : Math.PI / 2 }, { ...p.tops[0], x: tw * 0.25, w: tw * 0.3 }, ['tableware', 'food'], [1, 2], 0.3);
      return;
    }
  }

  private bathroom(c: RoomCtx) {
    const r = c.r, k = this.kit;
    // tub along a wall, pushed into a corner
    let tubSide: Side | null = null;
    for (const s of this.sidesByFreeLength(c, 1.72)) {
      const [lo, hi] = longestFree(s.sd);
      const t = (r.chance(0.5) ? lo + 0.86 : hi - 0.86);
      const f = this.onWall(c, s.sd, 1.7, 0.78, 0.62, t, 0.02, 0.0);
      if (f) {
        this.draw(f, () => F.clawfootTub(k));
        tubSide = s.sd;
        break;
      }
    }
    // pedestal sink with the mirror cabinet above, toilet beside it
    for (const s of this.sidesByFreeLength(c, 0.7)) {
      const f = this.onWall(c, s.sd, 0.62, 0.5, 0.9, 'any', 0.0, 0.0) as (Frame & { t: number }) | null;
      if (!f) continue;
      const [x, z] = this.at(s.sd, f.t, 0.0);
      this.kit.at(x, 0, z, f.rot, () => {
        this.kit.at(0, 0, 0.26, 0, () => F.pedestalSink(k, -0.26));
      });
      s.sd.used.push({ a: f.t - 0.35, b: f.t + 0.35, h: 9 });
      break;
    }
    for (const s of this.sidesByFreeLength(c, 0.6)) {
      const f = this.onWall(c, s.sd, 0.52, 0.72, 0.84, 'any', 0.0, 0.0);
      if (!f) continue;
      this.draw(f, () => F.toilet(k));
      break;
    }
    // towel bar on a free stretch of wall
    for (const s of this.sidesByFreeLength(c, 0.7)) {
      const [lo, hi] = longestFree(s.sd);
      if (hi - lo < 0.7) continue;
      const t = (lo + hi) / 2;
      const [x, z] = this.at(s.sd, t, 0);
      this.kit.at(x, 0, z, this.rotOf(s.sd), () => F.towelBar(k, r));
      s.sd.used.push({ a: t - 0.35, b: t + 0.35, h: 1.2 });
      break;
    }
    void tubSide;
    this.corners(c, 'plant', r.int(0, 1));
    this.corners(c, 'container', 1);
  }

  private study(c: RoomCtx) {
    const r = c.r, k = this.kit;
    const office = this.style === 'office';
    // desk under a window if there is one, else against the longest wall
    let placed = false;
    const winSides = c.sides.filter((s) => s.open.some((o) => o.kind === 'window'));
    for (const sd of [...winSides, ...this.sidesByFreeLength(c, 1.5).map((s) => s.sd)]) {
      const win = sd.open.find((o) => o.kind === 'window');
      const dw = office ? 1.6 : 1.4;
      let f: Frame | null = null;
      if (win) {
        const [x, z] = this.at(sd, win.t, 0.32 + 0.35);
        f = this.freeAt(c, dw, 0.7, x, z, this.rotOf(sd));
      } else f = this.onWall(c, sd, dw, 0.7, 0.75, midFree(sd), 0.02);
      if (!f) continue;
      const p = this.draw(f, () => F.desk(k, r, dw, office ? M.oak('#e8dcc8') : this.pal.wood, office ? M.matte('#d8d8d8') : M.black())) as F.Piece;
      const top = p.tops[0];
      this.kit.at(f.x, 0, f.z, f.rot, () => {
        F.monitor(k, -0.1, top.y, -0.12, r.chance(0.7));
        F.tableLamp(k, r, top.w / 2 - 0.15, top.y, -0.18);
        if (r.chance(0.6)) F.mug(k, r, -top.w / 2 + 0.2, top.y, 0.1);
      });
      this.cur.group.add(glow('#ffd59a', 0.5, f.x, top.y + 0.4, f.z, 0.3));
      this.decorateTop(r, f, { ...top, x: -top.w / 2 + 0.2, w: 0.3, d: 0.3, z: -0.12 }, ['stationery', 'electronics', 'plant', 'toy'], [1, 1], 0.3);
      // chair pulled up to the desk (front side)
      const c0 = Math.cos(f.rot), s0 = Math.sin(f.rot);
      const cx = f.x + 0.6 * s0, cz = f.z + 0.6 * c0;
      this.kit.at(cx, 0, cz, f.rot + Math.PI + r.range(-0.4, 0.4), () => F.officeChair(k, office ? M.fabric('#2d3138') : r.pick([this.pal.fabric, M.leather('#5a3a28')])));
      c.occ.push(rect(cx, cz, 0.6, 0.6));
      this.cols.push(rect(cx, cz, 0.4, 0.4));
      // private offices: two guest chairs facing the desk
      if (office) {
        for (const sgn of [-1, 1]) {
          const lx = sgn * 0.45, lz = 1.35;
          const gx = f.x + lx * c0 + lz * s0, gz = f.z - lx * s0 + lz * c0;
          const g = this.freeAt(c, 0.6, 0.6, gx, gz, 0, true, 0.0);
          if (g) this.libPiece({ x: gx, z: gz, rot: f.rot + Math.PI - sgn * 0.25 }, r.chance(0.5) ? pickLib('armchair', r) : null, (kk) => F.diningChair(kk, M.black(), M.leather('#2a2a2c')));
        }
      }
      placed = true;
      break;
    }
    if (!placed) return this.generic(c);
    // bookcases and a reading corner
    let nb = office ? 1 : r.int(1, 3);
    for (const s of this.sidesByFreeLength(c, 1.0)) {
      if (nb <= 0) break;
      const f = this.onWall(c, s.sd, 0.9, 0.34, 2.0);
      if (!f) continue;
      const p = this.draw(f, () => F.bookcase(k, r, 0.9, 2.0, office ? M.matte('#e4e4e2') : this.pal.wood, r.int(0, 9))) as F.Piece;
      for (const tp of p.tops) this.decorateTop(r, f, tp, ['stationery', 'toy', 'tableware', 'electronics'], [0, 1], 0.28);
      nb--;
    }
    if (office) {
      this.consoleGroup(c);
      this.corners(c, 'plant', 1);
    } else {
      this.corners(c, 'armchair', 1);
      this.corners(c, 'plant', 1);
    }
    this.paintings(c, r.int(1, 2));
  }

  private library(c: RoomCtx) {
    const r = c.r, k = this.kit;
    for (const s of c.sides) {
      for (let i = 0; i < 6; i++) {
        const f = this.onWall(c, s, 1.0, 0.34, 2.3);
        if (!f) break;
        const p = this.draw(f, () => F.bookcase(k, r, 1.0, 2.3, this.pal.dark, r.int(0, 9))) as F.Piece;
        for (const tp of p.tops.slice(0, -1)) this.decorateTop(r, f, tp, ['stationery', 'toy', 'tableware'], [0, 1], 0.28);
      }
    }
    this.diningGroup(c, 4);
    this.corners(c, 'floorlamp', 2);
    this.corners(c, 'armchair', 2);
  }

  private openPlan(c: RoomCtx) {
    const r = c.r, k = this.kit;
    const w = c.inner.maxX - c.inner.minX, d = c.inner.maxZ - c.inner.minZ;
    const long = w >= d;
    // rows of benching desks, two facing each other per row, along the long axis
    const dw = 1.5, pairD = 1.44;
    const rowPitch = pairD + 2.0;
    const L = long ? w : d, S = long ? d : w;
    const rows = Math.max(1, Math.floor((S - 1.2) / rowPitch));
    const per = Math.max(1, Math.floor((L - 2.0) / dw));
    const chairM = M.fabric(r.pick(['#2d3138', '#3d4a5c', '#4a3a3a']));
    for (let row = 0; row < rows; row++) {
      const s = (long ? c.inner.minZ : c.inner.minX) + (S - rows * rowPitch) / 2 + rowPitch * (row + 0.5);
      for (let i = 0; i < per; i++) {
        const a = (long ? c.inner.minX : c.inner.minZ) + (L - per * dw) / 2 + dw * (i + 0.5);
        const x = long ? a : s, z = long ? s : a;
        if (!this.freeAt(c, long ? dw : pairD, long ? pairD : dw, x, z, 0, true, 0.02)) continue;
        for (const side of [-1, 1]) {
          const rot = (long ? (side > 0 ? Math.PI : 0) : side > 0 ? -Math.PI / 2 : Math.PI / 2);
          const ox = long ? 0 : side * 0.36, oz = long ? side * 0.36 : 0;
          this.kit.at(x + ox, 0, z + oz, rot, () => {
            const p = F.desk(k, r, dw - 0.04, M.matte('#f2f2f0'), M.matte('#d0d0d0'));
            k.box(M.fabric('#6b7a6a'), dw - 0.1, 0.35, 0.03, 0, p.h, -0.34);
            F.monitor(k, 0, p.h, -0.1, r.chance(0.8));
            if (r.chance(0.4)) F.mug(k, r, 0.5, p.h, 0.05);
            // desk clutter: papers, a book stack, a phone, a desk lamp
            if (r.chance(0.7)) for (let j = 0; j < r.int(1, 4); j++) k.box(M.matte('#f4f4f0'), 0.21, 0.004, 0.297, -0.5 + r.range(-0.05, 0.05), p.h + j * 0.004, 0.08, r.range(-0.3, 0.3));
            if (r.chance(0.4)) F.bookStack(k, r, -0.45, p.h, -0.2);
            if (r.chance(0.5)) k.box(M.black(), 0.08, 0.012, 0.16, 0.3, p.h, 0.15, r.range(-0.4, 0.4));
            if (r.chance(0.3)) F.tableLamp(k, r, 0.55, p.h, -0.22);
            this.kit.at(r.range(-0.2, 0.2), 0, 0.65 + r.range(0, 0.15), Math.PI + r.range(-0.5, 0.5), () => F.officeChair(k, chairM));
          });
          if (r.chance(0.35)) {
            const c0 = Math.cos(rot), s0 = Math.sin(rot);
            const lx = -0.5;
            const px = x + ox + lx * c0, pz = z + oz - lx * s0;
            this.decorateTop(r, { x: px, z: pz, rot: 0 }, { x: 0, z: 0, y: 0.75, w: 0.3, d: 0.3 }, ['plant', 'stationery', 'tableware', 'toy', 'electronics'], [1, 1], 0.3);
          }
        }
        // chairs need room behind the desks
        c.occ.push(long ? rect(x, z, dw, pairD + 1.4) : rect(x, z, pairD + 1.4, dw));
      }
    }
    // a lounge: sofa, armchairs, coffee table on a rug
    this.lounge(c);
    // phone booths against a wall
    for (let i = 0; i < (Math.max(w, d) > 10 ? 2 : 1); i++) this.phoneBooth(c);
    // a kitchenette when the floor is big
    if (Math.max(w, d) > 9) this.kitchenette(c);
    // low storage with plants and binders, bookcases
    for (const s of this.sidesByFreeLength(c, 1.6).slice(0, 2)) {
      const f = this.onWall(c, s.sd, 1.5, 0.45, 0.75, 'any', 0.02) as (Frame & { t: number }) | null;
      if (!f) continue;
      const p = this.draw(f, () => F.dresser(k, r, M.matte('#e4e4e2'))) as F.Piece;
      this.movingParts(f, p.parts);
      this.libTop(r, f, { ...p.tops[0], x: -p.tops[0].w / 4, w: p.tops[0].w / 2 }, 'smallplant', 1, 0.4);
      this.kit.at(f.x, 0, f.z, f.rot, () => F.bookStack(k, r, p.tops[0].w / 4, p.tops[0].y, 0));
      this.painting(r, s.sd, f.t, 1.75, 1.0);
    }
    this.corners(c, 'plant', 4);
    this.paintings(c, r.int(1, 3));
  }

  /** sofa against a wall, two armchairs and a coffee table on a rug */
  private lounge(c: RoomCtx) {
    const r = c.r, k = this.kit;
    for (const s of this.sidesByFreeLength(c, 3.0)) {
      const sf = this.onWall(c, s.sd, 2.2, 0.92, 0.85, midFree(s.sd), 0.03) as (Frame & { t: number }) | null;
      if (!sf) continue;
      const fab = M.fabric(r.pick(['#3d4a5c', '#c4553a', '#e8c86a', '#5a6b5a', '#2f3d4f']));
      this.draw(sf, () => F.sofa(k, r, 2.2, fab, M.black(), this.pal.accent));
      const c0 = Math.cos(sf.rot), s0 = Math.sin(sf.rot);
      const at = (lx: number, lz: number): [number, number] => [sf.x + lx * c0 + lz * s0, sf.z - lx * s0 + lz * c0];
      const [rx, rz] = at(0, 1.2);
      k.flat(M.mapped(`rugo${this.desc.seed % 5}`, rugTex(hashN(this.desc.seed, 5, room2n(c.room)) % 40)), 3.0, 2.2, rx, 0.008, rz, 'keep', [1, 1], sf.rot);
      const [tx, tz] = at(0, 1.05);
      const tf = this.freeAt(c, 1.1, 0.6, tx, tz, sf.rot, true, 0.0);
      if (tf) {
        this.libPiece(tf, r.chance(0.5) ? 'modern_coffee_table_01' : null, (kk) => F.coffeeTable(kk, r, this.pal.wood, M.black(), M.marble()));
        this.libTop(r, tf, { x: 0, z: 0, y: 0.39, w: 0.9, d: 0.4 }, 'table', 1, 0.4);
      }
      for (const sgn of [-1, 1]) {
        const [ax, az] = at(sgn * 1.0, 1.75);
        const af = this.freeAt(c, 0.9, 0.9, ax, az, 0, true, 0.0);
        if (af) this.libPiece({ x: ax, z: az, rot: sf.rot + Math.PI + sgn * 0.5 }, r.chance(0.6) ? pickLib('armchair', r) : null, (kk) => F.armchair(kk, fab, M.black()));
      }
      return;
    }
  }

  /** a glass phone booth with a shelf and a stool */
  private phoneBooth(c: RoomCtx) {
    const r = c.r, k = this.kit;
    for (const s of this.sidesByFreeLength(c, 1.3)) {
      const f = this.onWall(c, s.sd, 1.1, 1.1, 2.3, 'any', 0.02) as (Frame & { t: number }) | null;
      if (!f) continue;
      const frame = M.matte('#2b2c2e');
      const felt = M.fabric(r.pick(['#5a6b5a', '#3d4a5c', '#8a5a4a', '#c9b79c']));
      this.kit.at(f.x, 0, f.z, f.rot, () => {
        k.box(felt, 1.1, 2.25, 0.04, 0, 0, -0.53);
        for (const sx of [-1, 1]) k.box(felt, 0.04, 2.25, 1.1, sx * 0.53, 0, 0);
        k.box(frame, 1.1, 0.05, 1.1, 0, 2.25, 0);
        k.box(frame, 1.1, 0.03, 1.1, 0, 0, 0);
        for (const sx of [-1, 1]) k.box(frame, 0.04, 2.25, 0.04, sx * 0.53, 0, 0.53);
        k.unshadowed(() => k.box(M.glass(), 1.02, 2.2, 0.012, 0, 0.03, 0.53));
        k.box(M.oak('#d8c4a4'), 0.9, 0.03, 0.35, 0, 1.0, -0.33);
        k.cyl(felt, 0.17, 0.17, 0.08, 0, 0.6, 0.05, 16);
        k.cyl(M.black(), 0.025, 0.025, 0.6, 0, 0, 0.05, 8);
        k.box(M.diffuser(), 0.6, 0.01, 0.3, 0, 2.23, 0);
      });
      this.libTop(r, f, { x: 0, z: -0.33, y: 1.03, w: 0.6, d: 0.25 }, 'smallplant', 1, 0.3);
      return;
    }
  }

  /** a short kitchen run with a fridge, and a high table with stools */
  private kitchenette(c: RoomCtx) {
    const r = c.r, k = this.kit;
    for (const s of this.sidesByFreeLength(c, 3.0)) {
      const f = this.onWall(c, s.sd, 2.8, 0.64, 2.3, 'any', 0.0, 0.0) as (Frame & { t: number }) | null;
      if (!f) continue;
      const p = this.draw(f, () =>
        F.kitchenRun(k, r, { len: 2.8, cab: M.painted('#f2f2f0'), counter: M.marble('#ffffff'), splash: M.subway('#f4f2ec'), fridgeAt: 1, rangeAt: 0.5, sinkAt: 0.3, uppers: true, ceilingH: this.H }),
      ) as F.Piece;
      for (const b of p.boxes ?? []) this.container(b.kind as Container['kind'], f, b);
      this.movingParts(f, p.parts);
      for (const tp of p.tops) this.libTop(r, f, tp, 'kitchen', 2, 0.4);
      // a high table with stools in front
      const c0 = Math.cos(f.rot), s0 = Math.sin(f.rot);
      const tx = f.x + 1.9 * s0, tz = f.z + 1.9 * c0;
      const tf = this.freeAt(c, 1.6, 0.7, tx, tz, f.rot, true, 0.02);
      if (tf) {
        this.kit.at(tx, 0, tz, f.rot, () => {
          k.box(M.oak('#d8c4a4'), 1.6, 0.04, 0.7, 0, 1.02, 0);
          for (const sx of [-1, 1]) k.box(M.black(), 0.05, 1.02, 0.5, sx * 0.7, 0, 0);
        });
        for (const sx of [-0.45, 0.45]) for (const sz of [-0.55, 0.55]) {
          const px = tx + sx * c0 + sz * s0, pz = tz - sx * s0 + sz * c0;
          this.libPiece({ x: px, z: pz, rot: f.rot + (sz > 0 ? Math.PI : 0) }, 'bar_chair_round_01', (kk) => void kk.cyl(M.black(), 0.2, 0.2, 0.75, 0, 0, 0, 12));
        }
      }
      return;
    }
  }

  private meeting(c: RoomCtx) {
    const r = c.r, k = this.kit;
    const w = c.inner.maxX - c.inner.minX, d = c.inner.maxZ - c.inner.minZ;
    const long = w >= d;
    const tl = Math.min(Math.max(w, d) - 2.2, 4.2), tdp = Math.min(1.2, Math.min(w, d) - 2.0);
    if (tl < 1.2 || tdp < 0.8) return this.generic(c);
    const cx = (c.inner.minX + c.inner.maxX) / 2, cz = (c.inner.minZ + c.inner.maxZ) / 2;
    const f = this.freeAt(c, long ? tl : tdp, long ? tdp : tl, cx, cz, 0, true, 0);
    if (!f) return this.generic(c);
    const wood = M.oak('#e8d8c0');
    const chairM = M.fabric(r.pick(['#2d3138', '#f2f2f0', '#3d4a5c']));
    this.kit.at(cx, 0, cz, long ? 0 : Math.PI / 2, () => {
      const p = F.diningTable(k, r, tl, tdp, wood);
      const n = Math.max(1, Math.floor(tl / 0.75));
      for (let i = 0; i < n; i++) {
        const x = -tl / 2 + (tl * (i + 0.5)) / n;
        for (const sgn of [-1, 1]) this.kit.at(x + r.range(-0.05, 0.05), 0, sgn * (tdp / 2 + 0.3), (sgn > 0 ? Math.PI : 0) + r.range(-0.2, 0.2), () => F.officeChair(k, chairM));
      }
      for (let i = 0; i < 3; i++) if (r.chance(0.6)) F.mug(k, r, r.range(-tl / 2 + 0.3, tl / 2 - 0.3), p.h, r.range(-0.2, 0.2));
    });
    this.decorateTop(r, f, { x: 0, z: 0, y: 0.75, w: 0.4, d: 0.4 }, ['electronics', 'stationery', 'tableware', 'plant'], [1, 2], 0.3);
    // a screen on the end wall
    const ends = c.sides.filter((s) => (long ? s.axis === 'x' : s.axis === 'z'));
    for (const s of ends) {
      if (freeRun(s) < 1.6) continue;
      const t = midFree(s);
      const [x, z] = this.at(s, t, 0.0);
      this.kit.at(x, 0, z, this.rotOf(s), () => {
        k.box(M.black(), 1.45, 0.83, 0.05, 0, 1.0, 0.03);
        k.box(M.screenOn(), 1.41, 0.79, 0.004, 0, 1.02, 0.056);
      });
      s.used.push({ a: t - 0.75, b: t + 0.75, h: 9 });
      break;
    }
    this.corners(c, 'plant', 1);
  }

  /** office reception: a desk facing the entry, the company name on the wall behind it, a waiting area */
  private reception(c: RoomCtx) {
    const r = c.r, k = this.kit;
    const back = c.sides.find((s) => s.axis === 'z' && s.inward > 0)!; // the wall facing the entry (+z side)
    const t = THREE.MathUtils.clamp(this.entry.x, back.e0 + 1.3, back.e1 - 1.3);
    const [x, z] = this.at(back, t, 1.0);
    const f = this.freeAt(c, 2.4, 0.8, x, z, 0, true, 0.02);
    if (f) {
      this.kit.at(x, 0, z, 0, () => {
        // a reception counter: low desk behind a raised transaction ledge
        k.box(M.oak('#d8c4a4'), 2.4, 1.05, 0.08, 0, 0, 0.36);
        k.box(M.marble('#ffffff'), 2.5, 0.04, 0.32, 0, 1.05, 0.3);
        for (const sx of [-1, 1]) k.box(M.oak('#d8c4a4'), 0.08, 1.05, 0.75, sx * 1.16, 0, 0);
        k.box(M.matte('#f2f2f0'), 2.3, 0.03, 0.7, 0, 0.72, -0.02);
        F.monitor(k, 0.5, 0.75, -0.1, true);
        F.mug(k, r, -0.6, 0.75, 0.05);
        this.kit.at(0, 0, -0.7, Math.PI, () => F.officeChair(k, M.fabric('#2d3138')));
      });
      this.libTop(r, { x, z, rot: 0 }, { x: -0.5, z: 0.3, y: 1.09, w: 0.6, d: 0.22 }, 'smallplant', 1, 0.4);
      c.occ.push(rect(x, z - 0.7, 1.0, 0.8));
      // the company name on the wall behind
      const name = this.desc.name.replace(/^\d+\s*/, '').toUpperCase().slice(0, 18) || 'RECEPTION';
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.45), new THREE.MeshStandardMaterial({ map: signTex(name, '#2b2c2e', '#e8e2d4'), roughness: 0.4 }));
      sign.userData.owned = true;
      const [sx, sz] = this.at(back, t, 0.02);
      sign.position.set(sx, 1.85, sz);
      this.cur.group.add(sign);
      back.used.push({ a: t - 1.0, b: t + 1.0, h: 9 });
    }
    // waiting area: sofa, coffee table, chairs, plants
    for (const s of this.sidesByFreeLength(c, 2.4)) {
      if (s.sd === back) continue;
      const sid = pickLib('sofa', r);
      const sw = sid ? LIB[sid][0] : 2.0, sdp = sid ? LIB[sid][2] : 0.9;
      const sf = this.onWall(c, s.sd, sw, sdp, 0.85, midFree(s.sd), 0.04);
      if (!sf) continue;
      this.libPiece(sf, sid, (kk) => F.sofa(kk, r, sw, M.fabric('#3d4a5c'), M.black(), this.pal.accent));
      const c0 = Math.cos(sf.rot), s0 = Math.sin(sf.rot);
      const tx = sf.x + (sdp / 2 + 0.55) * s0, tz = sf.z + (sdp / 2 + 0.55) * c0;
      const tf = this.freeAt(c, 1.2, 0.6, tx, tz, sf.rot, true, 0.0);
      if (tf) {
        this.libPiece(tf, 'modern_coffee_table_01', (kk) => F.coffeeTable(kk, r, this.pal.wood, M.black(), M.marble()));
        this.kit.at(tf.x, 0, tf.z, tf.rot, () => F.bookStack(k, r, 0.2, 0.39, 0));
      }
      break;
    }
    this.corners(c, 'plant', 3);
    this.paintings(c, 1);
  }

  private placeStairs(c: RoomCtx) {
    // 17-19 cm risers on 27 cm treads
    const sl = Math.round(this.H / 0.185) * 0.27, sw = 1.05;
    for (const s of this.sidesByFreeLength(c, sl + 0.2)) {
      const f = this.onWall(c, s.sd, sl, sw, 9, 'any', 0.0, 0.0) as (Frame & { t: number }) | null;
      if (!f) continue;
      // keep a landing clear at the bottom (local -x end)
      const bx = f.x - Math.cos(f.rot) * (sl / 2 + 0.6), bz = f.z + Math.sin(f.rot) * (sl / 2 + 0.6);
      c.occ.push(rect(bx, bz, 1.2, 1.2));
      this.kit.at(f.x, 0, f.z, f.rot, () => this.kit.at(0, 0, 0, Math.PI, () => F.stair(this.kit, sl, sw, this.H, M.oak('#b08a60'), M.trim(), M.trim())));
      const fp = footprint(sl, sw, f.rot, f.x, f.z);
      this.stairCore = { x: f.x, z: f.z, rot: f.rot, len: sl, width: sw, rect: fp };
      const next = this.desc.floor + 1;
      this.ports.push({
        box: new THREE.Box3(new THREE.Vector3(fp.minX - 0.3, 0, fp.minZ - 0.3), new THREE.Vector3(fp.maxX + 0.3, this.H, fp.maxZ + 0.3)),
        label: `Go upstairs to floor ${next + 1}`,
        sub: `${this.desc.floors} floors in this building`,
        target: { ...this.desc, floor: next },
      });
      // the stairwell opening in the ceiling
      return;
    }
  }

  /** a console or chest against a free wall: lamp, books, objects, a painting above */
  private consoleGroup(c: RoomCtx) {
    const r = c.r, k = this.kit;
    const id = r.chance(0.5) ? pickLib('dresser', r, (s) => s[1] < 1.0) : null;
    const s = id ? LIB[id] : [1.3, 0.86, 0.45];
    for (const cand of this.sidesByFreeLength(c, s[0] + 0.3)) {
      const f = this.onWall(c, cand.sd, s[0], s[2], s[1], midFree(cand.sd), 0.02) as (Frame & { t: number }) | null;
      if (!f) continue;
      const p = this.libPiece(f, id, (kk) => F.dresser(kk, r, this.pal.wood)) as F.Piece;
      const top = id ? { x: 0, z: 0, y: s[1], w: s[0] - 0.12, d: s[2] - 0.12 } : p.tops[0];
      if (id) this.libDrawerSet(f, 'dresser', s, 3);
      else this.movingParts(f, p.parts);
      this.kit.at(f.x, 0, f.z, f.rot, () => {
        F.tableLamp(k, r, -top.w / 2 + 0.18, top.y, 0);
        F.bookStack(k, r, 0.05, top.y, 0.02);
      });
      this.cur.group.add(glow('#ffd59a', 0.5, f.x, top.y + 0.4, f.z, 0.25));
      this.libTop(r, f, { ...top, x: top.w / 4, w: top.w / 2 }, 'table', 1, 0.5);
      this.painting(r, cand.sd, f.t, top.y + 1.0, Math.min(1.1, s[0] * 0.8));
      return;
    }
  }

  /** a cluster of small framed photos and prints over a free stretch of wall */
  private galleryWall(c: RoomCtx) {
    const r = c.r, k = this.kit;
    for (const s of this.sidesByFreeLength(c, 2.0)) {
      const [lo, hi] = longestFree(s.sd, 0.9);
      if (hi - lo < 1.8) continue;
      const t0 = (lo + hi) / 2;
      const cols = r.int(2, 3), rows = 2;
      const fw = 0.34, fh = 0.42, gap = 0.08;
      const total = cols * fw + (cols - 1) * gap;
      if (s.sd.used.some((u) => (u.h > 0.9 || u.h === 0) && t0 + total / 2 > u.a && t0 - total / 2 < u.b)) continue;
      const frame = r.pick([M.black(), M.brass(), M.matte('#f4f1ea'), this.pal.wood]);
      const [x0, z0] = this.at(s.sd, t0, 0.0);
      this.kit.at(x0, 0, z0, this.rotOf(s.sd), () => {
        for (let i = 0; i < cols; i++)
          for (let j = 0; j < rows; j++) {
            const ww = fw * r.range(0.8, 1.15), hh = fh * r.range(0.75, 1.1);
            const x = -total / 2 + fw / 2 + i * (fw + gap) + r.range(-0.03, 0.03);
            const y = 1.45 + j * (fh + gap) + r.range(-0.03, 0.03);
            k.box(frame, ww + 0.04, hh + 0.04, 0.025, x, y - 0.02, 0.012);
            if (r.chance(0.6)) k.box(M.matte('#f4f1ea'), ww, hh, 0.002, x, y, 0.026);
            k.quad(M.mapped(`photo${(i * 7 + j * 3 + this.desc.seed) % 12}`, photoTex((i * 7 + j * 3 + this.desc.seed) % 12)), ww * 0.7, hh * 0.7, x, y + hh / 2, 0.028);
          }
      });
      s.sd.used.push({ a: t0 - total / 2 - 0.1, b: t0 + total / 2 + 0.1, h: 0 });
      return;
    }
  }

  /** a side chair against a wall with a small table and a plant or lamp */
  private accentChair(c: RoomCtx) {
    const r = c.r, k = this.kit;
    for (const cand of this.sidesByFreeLength(c, 1.4)) {
      const f = this.onWall(c, cand.sd, 1.25, 0.62, 1.0, 'any', 0.04) as (Frame & { t: number }) | null;
      if (!f) continue;
      const id = r.chance(0.6) ? pickLib('diningchair', r) : null;
      const cx = -0.3;
      const c0 = Math.cos(f.rot), s0 = Math.sin(f.rot);
      this.libPiece({ x: f.x + cx * c0, z: f.z - cx * s0, rot: f.rot + r.range(-0.2, 0.2) }, id, (kk) => F.diningChair(kk, this.pal.wood, r.pick(this.pal.accent)));
      // the side table sits at +0.35 along
      const tx = f.x + 0.35 * c0, tz = f.z - 0.35 * s0;
      this.kit.at(tx, 0, tz, f.rot, () => F.sideTable(k, this.pal.wood, 0.5));
      this.libTop(r, { x: tx, z: tz, rot: f.rot }, { x: 0, z: 0, y: 0.5, w: 0.36, d: 0.36 }, r.chance(0.5) ? 'smallplant' : 'table', 1, 0.45);
      return;
    }
  }

  /** fill some corners with a plant, a floor lamp, an armchair or a container */
  private corners(c: RoomCtx, what: 'plant' | 'floorlamp' | 'armchair' | 'container', n: number) {
    const r = c.r, k = this.kit;
    const cs: [number, number, number][] = [
      [c.inner.minX, c.inner.minZ, Math.PI / 4],
      [c.inner.maxX, c.inner.minZ, -Math.PI / 4],
      [c.inner.minX, c.inner.maxZ, (3 * Math.PI) / 4],
      [c.inner.maxX, c.inner.maxZ, (-3 * Math.PI) / 4],
    ];
    r.shuffle(cs);
    const size = what === 'armchair' ? 0.95 : what === 'plant' ? 0.6 : 0.45;
    for (const [x0, z0, rot] of cs) {
      if (n <= 0) return;
      const x = x0 + (x0 === c.inner.minX ? 1 : -1) * (size / 2 + 0.05);
      const z = z0 + (z0 === c.inner.minZ ? 1 : -1) * (size / 2 + 0.05);
      const fp = rect(x, z, size, size);
      if (!c.free(fp, 0.02)) continue;
      // keep corners in front of windows clear for tall things
      c.occ.push(fp);
      this.cols.push(shrink(fp, 0.08));
      if (what === 'plant') {
        const pid = r.chance(0.45) ? pickLib('bigplant', r) : null;
        if (pid) this.libPiece({ x, z, rot: r.range(0, 6) }, pid, () => undefined);
        else if (r.chance(0.5)) this.kit.at(x, 0, z, r.range(0, 6), () => F.plant(k, r, r.range(0.9, 1.7)));
        else {
          const e = pickModel('plant', r);
          if (e) {
            const sc = normScale(e, 'plant');
            const sp = this.put(e, Math.min(sc, scaleTo(e, size * 0.9, 'horiz')), x, 0, z, r.int(0, 3) * (Math.PI / 2), 'plant');
            if (sp.size.y < 0.6) this.kit.at(x, sp.size.y * 0.8, z, 0, () => F.plant(k, r, 0.5, true));
          } else this.kit.at(x, 0, z, 0, () => F.plant(k, r, 1.2));
        }
      } else if (what === 'floorlamp') {
        this.kit.at(x, 0, z, 0, () => F.floorLamp(k, r));
        this.cur.group.add(glow('#ffd59a', 0.6, x, 1.5, z, 0.3));
      } else if (what === 'armchair') {
        this.kit.at(x, 0, z, rot, () => F.armchair(k, r.chance(0.5) ? this.pal.accent[0] : M.leather('#6a4028'), M.walnut()));
      } else {
        const e = pickModel('container', r);
        if (e) this.put(e, Math.min(normScale(e, 'container'), scaleTo(e, size * 0.9, 'horiz')), x, 0, z, r.int(0, 3) * (Math.PI / 2), 'container');
      }
      n--;
    }
  }

  /** set bundled models (portals) on a surface of a placed piece */
  private decorateTop(r: Rng, f: Frame, t: F.Top, roles: string[], n: [number, number], maxH: number, edge = false) {
    const fp = this.topRect(f, t);
    void edge;
    this.surface(r, t.y, fp, roles, n, maxH);
  }

  private paintings(c: RoomCtx, n: number) {
    const r = c.r;
    for (let i = 0; i < n; i++) {
      const s = r.pick(c.sides);
      const [lo, hi] = longestFree(s, 1.0);
      if (hi - lo < 1.3) continue;
      const pw = Math.min(r.range(0.6, 1.3), hi - lo - 0.3);
      this.painting(r, s, (lo + hi) / 2 + r.range(-0.2, 0.2) * (hi - lo - pw), 1.6, pw);
    }
  }

  // ------------------------------------------------------------------ generic rooms (shops, galleries, storage)

  private generic(c: RoomCtx) {
    const r = c.r;
    const spec = GENERIC[c.room.type] ?? GENERIC.storage;
    const { ix0, iz0, ix1, iz1 } = { ix0: c.inner.minX, iz0: c.inner.minZ, ix1: c.inner.maxX, iz1: c.inner.maxZ };
    const w = ix1 - ix0, d = iz1 - iz0;
    const cx = (ix0 + ix1) / 2, cz = (iz0 + iz1) / 2;
    const place = (e: ModelEntry, scale: number, where: Spec['where']): { x: number; z: number; rot: number; fp: Rect; size: THREE.Vector3 } | null => {
      const sx = e.size[0] * scale, sy = e.size[1] * scale, sz = e.size[2] * scale;
      const size = new THREE.Vector3(sx, sy, sz);
      for (let k = 0; k < 40; k++) {
        let x = 0, z = 0, rot = 0;
        if (where === 'center') {
          x = cx + r.range(-0.3, 0.3);
          z = cz + r.range(-0.3, 0.3);
          rot = sx > sz !== w > d ? Math.PI / 2 : 0;
        } else if (where === 'free') {
          x = r.range(ix0, ix1);
          z = r.range(iz0, iz1);
          rot = r.int(0, 3) * (Math.PI / 2);
        } else {
          const side = r.int(0, 3);
          rot = [0, Math.PI, Math.PI / 2, -Math.PI / 2][side];
          const q = side >= 2;
          const fw = q ? sz : sx, fd = q ? sx : sz;
          const corner = where === 'corner';
          if (side === 0 || side === 1) {
            x = corner ? (r.chance(0.5) ? ix0 + fw / 2 : ix1 - fw / 2) : r.range(ix0 + fw / 2, ix1 - fw / 2);
            z = side === 0 ? iz0 + fd / 2 + 0.02 : iz1 - fd / 2 - 0.02;
          } else {
            z = corner ? (r.chance(0.5) ? iz0 + fd / 2 : iz1 - fd / 2) : r.range(iz0 + fd / 2, iz1 - fd / 2);
            x = side === 2 ? ix0 + fw / 2 + 0.02 : ix1 - fw / 2 - 0.02;
          }
        }
        const fp = footprint(sx, sz, rot, x, z);
        if (!c.free(fp, 0.08)) continue;
        return { x, z, rot, fp, size };
      }
      return null;
    };
    for (const it of spec.items) {
      const n = r.int(it.n[0], it.n[1]);
      for (let i = 0; i < n; i++) {
        if (it.role === 'pedestal') {
          this.pedestal(r, place, c.occ);
          continue;
        }
        const e = pickModel(it.role, r);
        if (!e) continue;
        const scale = normScale(e, it.role) * r.range(0.95, 1.05);
        const p = place(e, scale, it.where);
        if (!p) continue;
        c.occ.push(p.fp);
        const sp = this.put(e, scale, p.x, 0, p.z, p.rot, it.role);
        if (it.on) this.surface(r, sp.size.y, p.fp, it.on, it.onN ?? [1, 2], 0.8);
      }
    }
    this.paintings(c, r.int(spec.paintings[0], spec.paintings[1]));
  }

  // ------------------------------------------------------------------ models and portals

  private put(e: ModelEntry, scale: number, x: number, y: number, z: number, rot: number, role: string) {
    const sp = spawn(e, scale);
    sp.obj.position.set(x, y, z);
    sp.obj.rotation.y = rot;
    this.cur.group.add(sp.obj);
    const fp = footprint(sp.size.x, sp.size.z, rot, x, z);
    if (y < 0.05) {
      this.cols.push(shrink(fp, 0.06));
      this.cur.group.add(blob(fp.maxX - fp.minX, fp.maxZ - fp.minZ, x, z));
    }
    if (!NOT_PORTAL.has(role)) {
      const bx = rectBox3(fp, y, y + sp.size.y, 0.04);
      const size = Math.max(sp.size.x, sp.size.y, sp.size.z);
      const rng = new Rng(hashN(this.desc.seed, x * 1000, z * 1000, y * 1000));
      const biome = rng.pick(ROLE_BIOMES[role] ?? ROLE_BIOMES[e.role] ?? Object.keys(BIOMES));
      this.ports.push({
        box: bx,
        label: `Shrink into “${e.title}”`,
        sub: `${e.role}${e.author ? ` · by ${e.author}` : ''}`,
        target: { kind: 'city', seed: rng.int(0, 2 ** 31), biome, name: `Inside “${e.title}”`, source: e, sourceScale: size },
        shrink: size,
      });
    }
    return sp;
  }

  /** scatter `n` small models of `roles` on a surface rect at height `top` */
  private surface(r: Rng, top: number, fp: Rect, roles: string[], n: [number, number], maxH: number) {
    const count = r.int(n[0], n[1]);
    const used: Rect[] = [];
    for (let i = 0; i < count; i++) {
      const role = r.pick(roles);
      const e = pickModel(role, r);
      if (!e) continue;
      let scale = normScale(e, role);
      const fw = fp.maxX - fp.minX, fd = fp.maxZ - fp.minZ;
      const maxFoot = Math.min(fw, fd) * 0.9;
      const foot = Math.max(e.size[0], e.size[2]) * scale;
      if (foot > maxFoot) scale *= maxFoot / foot;
      if (e.size[1] * scale > maxH) scale *= maxH / (e.size[1] * scale);
      // things too small to see after shrinking are not worth placing
      if (Math.max(...e.size) * scale < 0.05) continue;
      const sx = e.size[0] * scale, sz = e.size[2] * scale;
      for (let k = 0; k < 12; k++) {
        const rot = r.int(0, 3) * (Math.PI / 2);
        const q = Math.round(rot / (Math.PI / 2)) & 1;
        const hw = (q ? sz : sx) / 2, hd = (q ? sx : sz) / 2;
        if (fp.minX + hw > fp.maxX - hw || fp.minZ + hd > fp.maxZ - hd) break;
        const x = r.range(fp.minX + hw, fp.maxX - hw);
        const z = r.range(fp.minZ + hd, fp.maxZ - hd);
        const f = footprint(sx, sz, rot, x, z);
        if (used.some((u) => overlaps(u, f, 0.02))) continue;
        used.push(f);
        this.put(e, scale, x, top, z, rot, role);
        break;
      }
    }
  }

  private pedestal(r: Rng, place: (e: ModelEntry, s: number, w: 'free') => { x: number; z: number; rot: number; fp: Rect; size: THREE.Vector3 } | null, occ: Rect[]) {
    const role = r.pick(PEDESTAL_ROLES);
    const e = pickModel(role, r);
    if (!e) return;
    const ph = r.range(0.7, 1.1);
    const pw = r.range(0.8, 1.3);
    const fake: ModelEntry = { ...e, size: [pw, ph, pw] };
    const p = place(fake, 1, 'free');
    if (!p) return;
    occ.push(rect(p.x, p.z, pw + 1.2, pw + 1.2));
    const stone = mat(r.pick(['#f2efe8', '#2b2b2e', '#d8cbb3', '#9aa3ab']), { rough: 0.4 });
    this.kit.box(stone, pw, ph, pw, p.x, 0, p.z);
    this.kit.box(stone, pw + 0.12, 0.06, pw + 0.12, p.x, ph, p.z);
    this.cols.push(rect(p.x, p.z, pw, pw));
    const scale = scaleTo(e, pw * r.range(0.7, 0.95), 'max');
    const rot = r.range(0, Math.PI * 2);
    const sp = spawn(e, scale);
    sp.obj.position.set(p.x, ph + 0.06, p.z);
    sp.obj.rotation.y = rot;
    this.cur.group.add(sp.obj);
    this.cur.group.add(glow('#fff2d6', 1.6, p.x, ph + 0.06 + sp.size.y + 0.3, p.z, 0.35));
    const rng = new Rng(hashN(this.desc.seed, p.x * 999, p.z * 999));
    const biome = rng.pick(ROLE_BIOMES[e.role] ?? Object.keys(BIOMES));
    const bx = new THREE.Box3(new THREE.Vector3(p.x - pw / 2, 0, p.z - pw / 2), new THREE.Vector3(p.x + pw / 2, ph + sp.size.y + 0.1, p.z + pw / 2));
    this.ports.push({
      box: bx,
      label: `Shrink into “${e.title}”`,
      sub: `exhibit · ${e.role}${e.author ? ` · by ${e.author}` : ''}`,
      target: { kind: 'city', seed: rng.int(0, 2 ** 31), biome, name: `Inside “${e.title}”`, source: e, sourceScale: Math.max(sp.size.x, sp.size.y, sp.size.z) },
      shrink: Math.max(sp.size.x, sp.size.y, sp.size.z),
    });
  }

  /** a framed painting (a portal) on a side at `t`, its centre at height `y` */
  private painting(r: Rng, sd: Side, t: number, y: number, pw: number) {
    const ph = pw * r.range(0.68, 0.8);
    y = Math.min(y, this.H - 0.35 - ph / 2);
    if (sd.used.some((u) => (u.h > 8 || u.h > y - ph / 2 - 0.08) && t + pw / 2 > u.a && t - pw / 2 < u.b)) return;
    sd.used.push({ a: t - pw / 2 - 0.1, b: t + pw / 2 + 0.1, h: 0 });
    const seed = r.int(0, 1e6);
    const frame = mat(r.pick(['#3a2a1a', '#b8925a', '#1a1a1a', '#e8e2d6']), { rough: 0.5, metal: 0.2 });
    const art = new THREE.MeshStandardMaterial({ map: paintingTex(seed), roughness: 0.7 });
    const grp = new THREE.Group();
    grp.add(box(frame, pw + 0.1, ph + 0.1, 0.045, 0, -(ph + 0.1) / 2, 0.022, false));
    if (r.chance(0.5)) grp.add(box(mat('#f4f1ea', { rough: 0.9 }), pw - 0.02, ph - 0.02, 0.003, 0, -(ph - 0.02) / 2, 0.046, false));
    const inset = r.chance(0.5) ? 0.12 : 0;
    const pic = new THREE.Mesh(new THREE.PlaneGeometry(pw - inset, ph - inset), art);
    pic.userData.owned = true;
    pic.position.z = 0.05;
    grp.add(pic);
    const [x, z] = this.at(sd, t, 0.005);
    grp.position.set(x, y, z);
    grp.rotation.y = this.rotOf(sd);
    this.cur.group.add(grp);
    const name = paintingName(new Rng(seed));
    const bx = new THREE.Box3().setFromObject(grp).expandByScalar(0.08);
    this.ports.push({
      box: bx,
      label: `Step into the painting “${name}”`,
      sub: 'oil on canvas, artist unknown',
      target: { kind: 'city', seed: hashN(seed, 4242), biome: r.pick(ROLE_BIOMES.painting), name: `Inside “${name}”` },
      shrink: pw,
    });
  }
}

interface RoomCtx {
  room: Room;
  r: Rng;
  occ: Rect[];
  inner: Rect;
  sides: Side[];
  free: (fp: Rect, pad?: number) => boolean;
}

function area(r: Room) {
  return (r.x1 - r.x0) * (r.z1 - r.z0);
}
function room2n(r: Room) {
  return Math.round(r.x0 * 7 + r.z0 * 13);
}
function shrink(r: Rect, m: number): Rect {
  return { minX: r.minX + m, minZ: r.minZ + m, maxX: r.maxX - m, maxZ: r.maxZ - m };
}
/** the longest stretch of a side not taken by openings or tall things */
function longestFree(sd: Side, minH = 0): [number, number] {
  const bl = sd.used.filter((u) => u.h > minH || u.h > 8).sort((a, b) => a.a - b.a);
  let best: [number, number] = [sd.e0, sd.e0];
  let a = sd.e0;
  for (const u of [...bl, { a: sd.e1, b: sd.e1, h: 9 }]) {
    if (u.a - a > best[1] - best[0]) best = [a, Math.min(u.a, sd.e1)];
    a = Math.max(a, u.b);
  }
  return best;
}
function freeRun(sd: Side) {
  const [a, b] = longestFree(sd);
  return b - a;
}
function midFree(sd: Side) {
  const [a, b] = longestFree(sd);
  return (a + b) / 2;
}

/** a curtain panel: a vertical sheet with soft folds, centred on x, base at y = -h/2 */
const curtainCache = new Map<string, THREE.BufferGeometry>();
function curtainGeo(w: number, h: number) {
  const key = `${w.toFixed(2)}|${h.toFixed(2)}`;
  let g = curtainCache.get(key);
  if (g) return g;
  g = new THREE.PlaneGeometry(w, h, 24, 1);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) p.setZ(i, Math.sin((p.getX(i) / w) * Math.PI * 7) * 0.035);
  g.computeVertexNormals();
  curtainCache.set(key, g);
  return g;
}

/**
 * Drawers for a library (Poly Haven) dresser or nightstand, whose model has its drawer fronts baked
 * in: rows of drawers on its front face (size [w, h, d], frame at its centre, front at +d/2). Their
 * fronts are only drawn while open (Container.hideClosed), so the closed model looks as it was.
 */
export function libDrawers(kind: 'dresser' | 'nightstand', size: readonly number[], rows: number, mat: THREE.Material): F.Part[] {
  const [w, h, d] = size;
  // a nightstand has one drawer under its top; a dresser is drawers from the plinth to the top
  const y0 = kind === 'nightstand' ? Math.max(0.1, h - 0.22) : 0.1, y1 = h - 0.05;
  const rh = (y1 - y0) / rows;
  const out: F.Part[] = [];
  for (let i = 0; i < rows; i++) out.push({ move: 'drawer', kind, x: 0, y: y0 + rh * i + 0.004, z: d / 2 + 0.004, w: Math.max(0.2, w - 0.1), h: rh - 0.012, d: Math.max(0.15, d - 0.1), mat });
  return out;
}
