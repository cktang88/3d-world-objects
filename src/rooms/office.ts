import * as THREE from 'three';
import type { Env, Level, LevelDesc, Portal, Rect } from '../level';
import { disposeTree, finishBuilding } from '../level';
import { Kit } from './kit';
import { M } from './mats';
import * as F from './furniture';
import { LIB, libEnabled } from './lib';
import { loadCatalog, loadLibraryModel, type LibraryEntry } from '../libraries';
import { ABORTED } from '../dispose';
import { Rng, hashN } from '../rng';
import { mat } from '../build';
import { surface } from '../pbr';
import { paintingTex, signTex } from '../textures';

/**
 * Office suites (docs/research/offices.md): the floors behind the suite doors of office towers and
 * loft buildings (src/rooms/vertical.ts). A suite has a type (open-plan tech, cubicle farm, law
 * firm, creative loft, 1980s office, dentist, gym, co-working), picked by `officeTypeFor` from the
 * building, floor, unit and district, so a revisit shows the same suite.
 *
 * Plan (level coordinates, metres): the floor plate is W x D centred on the origin, the entry door
 * in the front wall (z = +D/2) near the left corner. A 1.5 m spine aisle runs across the plate
 * 4 m in from the front wall; the front strip holds reception, waiting and the kitchenette; the
 * work area behind the spine is filled in columns running back from the spine, with aisles of at
 * least 1.1 m between them. Office types get a glass meeting room at the back right.
 *
 * Built in slices (`staging`), merged per material by a Kit; repeated chairs and monitors are
 * InstancedMeshes. Library decor (lamps, laptops, plants, frames) streams in only when you come
 * within 9 m. Everything is freed by disposeTree on eviction (src/dispose.ts).
 */

export const OFFICE_TYPES = ['tech', 'cubicle', 'law', 'creative', 'eighties', 'dentist', 'gym', 'cowork'] as const;
export type OfficeType = (typeof OFFICE_TYPES)[number];
export const OFFICE_NAMES: Record<OfficeType, string> = {
  tech: 'a tech start-up, open plan', cubicle: 'corporate offices', law: 'a law firm', creative: 'a creative agency',
  eighties: 'offices (not redecorated since 1985)', dentist: 'a dental practice', gym: 'a fitness studio', cowork: 'a co-working space',
};
const COMPANY: Record<OfficeType, string[]> = {
  tech: ['NIMBUS LABS', 'QUANTA', 'BRIGHTLOOP', 'PIXELFORGE', 'HELIX.IO'],
  cubicle: ['MERIDIAN GROUP', 'ATLAS HOLDINGS', 'CONTINENTAL TRUST', 'APEX CORP'],
  law: ['HALE & WHITCOMB LLP', 'STERLING BRANDT', 'ASHFORD LAW', 'MORROW KANE LLP'],
  creative: ['studio/fold', 'OKAY DONE', 'NORTH&CO', 'Field Notes Agency'],
  eighties: ['ACME INSURANCE', 'DATACORP', 'UNITED TEXTILES', 'FIRST FEDERAL'],
  dentist: ['MIDTOWN DENTAL', 'BRIGHT SMILES', 'PARK AVE DENTISTRY'],
  gym: ['IRON & OAK', 'PULSE FITNESS', 'REP STUDIO'],
  cowork: ['THE COMMONS', 'HIVE WORKSPACE', 'DESK & CO'],
};

// ------------------------------------------------------------------ library models used here

/** real sizes (m, w x h x d) of the library models a suite uses: Poly Haven decor and frames, GSO mugs */
export const OFFICE_LIB: Record<string, [number, number, number]> = {
  ...LIB,
  hanging_picture_frame_01: [0.594, 0.841, 0.016],
  hanging_picture_frame_02: [0.752, 0.5, 0.033],
  hanging_picture_frame_03: [0.385, 0.502, 0.032],
  fancy_picture_frame_01: [0.603, 0.464, 0.02],
  fancy_picture_frame_02: [0.661, 0.771, 0.089],
  ACE_Coffee_Mug_Kristen_16_oz_cup: [0.126, 0.135, 0.091],
  Cole_Hardware_Mug_Classic_Blue: [0.166, 0.095, 0.126],
};
const GSO_IDS = new Set(['ACE_Coffee_Mug_Kristen_16_oz_cup', 'Cole_Hardware_Mug_Classic_Blue']);
const catalogs = new Map<string, Promise<Map<string, LibraryEntry>>>();
function catalog(src: 'gso' | 'polyhaven') {
  let p = catalogs.get(src);
  if (!p) catalogs.set(src, (p = loadCatalog(src).then((all) => new Map(all.map((e) => [e.id, e]))).catch(() => new Map<string, LibraryEntry>())));
  return p;
}

// ------------------------------------------------------------------ which type where

type Weights = Partial<Record<OfficeType, number>>;
const BY_BUILDING: Record<string, Weights> = {
  office: { tech: 3, cubicle: 3, law: 3, eighties: 2, cowork: 1.5, dentist: 1, creative: 1, gym: 0.5 },
  loft: { creative: 4, tech: 3, cowork: 2, gym: 1.5, dentist: 0.7, eighties: 0.6 },
};
const BY_DISTRICT: Record<string, Weights> = {
  midtown: { law: 1.6, cubicle: 1.5 }, timesq: { cubicle: 1.4, eighties: 1.3 }, museum: { law: 1.5, dentist: 2 },
  garment: { creative: 1.6, eighties: 1.4 }, canal: { creative: 1.4, eighties: 1.5 }, bowery: { creative: 1.8, gym: 1.5 },
  industrial: { creative: 2, tech: 1.5, gym: 1.6 }, construction: { tech: 2, cowork: 1.8 }, market: { cowork: 1.6, dentist: 1.3 },
  brownstone: { dentist: 2, law: 1.2 },
};

/**
 * The suite type of unit `unit` on floor `floor` of a building (deterministic). Each unit index is a
 * column up the building: a floor never repeats the type of the same unit on the floor below, and
 * units next to each other on a floor differ when they can.
 */
export function officeTypeFor(seed: number, building: string, district: string | undefined, floor: number, unit: number): OfficeType {
  const w = { ...(BY_BUILDING[building] ?? BY_BUILDING.office) };
  for (const [k, f] of Object.entries(BY_DISTRICT[district ?? ''] ?? {})) if (w[k as OfficeType]) w[k as OfficeType]! *= f!;
  const pick = (r: Rng, not: Set<OfficeType>) => {
    const list = (Object.entries(w) as [OfficeType, number][]).filter(([t]) => !not.has(t));
    let x = r.next() * list.reduce((s, [, v]) => s + v, 0);
    for (const [t, v] of list) if ((x -= v) <= 0) return t;
    return list[list.length - 1][0];
  };
  let below: OfficeType[] = [];
  for (let f = 1; f <= Math.max(1, floor); f++) {
    const row: OfficeType[] = [];
    for (let u = 0; u <= unit; u++) {
      const not = new Set<OfficeType>();
      if (below[u]) not.add(below[u]);
      if (u > 0) not.add(row[u - 1]);
      row.push(pick(new Rng(hashN(seed, f, u, 4711)), not));
    }
    below = row;
  }
  return below[unit];
}

// ------------------------------------------------------------------ the level

interface Look {
  W: number; D: number; H: number;
  floor: THREE.Material; wall: THREE.Material; ceiling: 'drop' | 'open' | 'plaster';
  desk: THREE.Material; leg: THREE.Material; chair: THREE.Material; light: string; warm: boolean;
}
export interface DeskInfo { x0: number; x1: number; z0: number; z1: number; top: number }
export interface ClutterInfo { kind: string; x: number; z: number; y: number; w: number; d: number; h: number; desk: number }

const INSTANCED = new Map<string, { geo: THREE.BufferGeometry; mat: THREE.Material }[]>();
/** chair / monitor geometry built once per look, then drawn as InstancedMeshes */
function parts(key: string, build: (k: Kit) => void) {
  let p = INSTANCED.get(key);
  if (!p) {
    const k = new Kit();
    build(k);
    const g = new THREE.Group();
    k.finish(g);
    p = g.children.map((c) => {
      const m = c as THREE.Mesh;
      m.geometry.userData.owned = false; // shared by every suite: pinned, not freed with a suite
      return { geo: m.geometry, mat: m.material as THREE.Material };
    });
    INSTANCED.set(key, p);
  }
  return p;
}

export class OfficeLevel implements Level {
  name: string;
  group = new THREE.Group();
  spawn = { pos: new THREE.Vector3(), yaw: 0 };
  env: Env;
  type: OfficeType;
  doorway?: Level['doorway'];
  staging?: Iterator<unknown>;
  /** qa: desks, desk clutter, seat points, meeting rooms */
  desks: DeskInfo[] = [];
  clutter: ClutterInfo[] = [];
  seats: THREE.Vector3[] = [];
  rooms: Rect[] = [];
  look!: Look;
  private cols: Rect[] = [];
  private ports: Portal[] = [];
  private kit = new Kit();
  private rng: Rng;
  private holders: { o: THREE.Group; id: string; done: boolean }[] = [];
  private loads = new AbortController();
  private chairs: THREE.Matrix4[] = [];
  private screens: THREE.Matrix4[] = [];
  private lights: THREE.PointLight[] = [];

  constructor(desc: Extract<LevelDesc, { kind: 'interior' }>, opts: { staged?: boolean; cutaway?: boolean; lights?: boolean } = {}) {
    this.type = (OFFICE_TYPES as readonly string[]).includes(desc.office ?? '') ? (desc.office as OfficeType) : 'cubicle';
    this.rng = new Rng(hashN(desc.seed, 991));
    this.name = desc.name;
    this.group.name = `office:${this.type}`;
    this.env = {
      skyTop: '#1a1612', skyBottom: '#2a241e', stars: false, fog: null, fogNear: 0, fogFar: 0, sun: null,
      hemi: { sky: '#f4f6ff', ground: '#5a5a58', intensity: 0.5 }, ambient: 0.06, envIntensity: 0.4, exposure: 1.0,
    };
    this.staging = this.generate(!!opts.cutaway, opts.lights !== false);
    if (!opts.staged) finishBuilding(this);
  }

  colliders() {
    return this.cols;
  }
  portals() {
    return this.ports;
  }
  update(_dt: number, p: THREE.Vector3) {
    // library decor streams in when you come near (lazy); its copy is freed with the suite
    for (const h of this.holders) {
      if (h.done) continue;
      const dx = h.o.position.x - p.x, dz = h.o.position.z - p.z;
      if (dx * dx + dz * dz < 81) {
        h.done = true;
        void this.stream(h);
      }
    }
  }
  dispose() {
    this.loads.abort(ABORTED); // in-flight library loads drop their continuation (src/dispose.ts)
    disposeTree(this.group);
  }

  private lookFor(t: OfficeType): Look {
    const r = this.rng;
    const L = (o: Partial<Look> & Pick<Look, 'floor' | 'wall' | 'ceiling'>): Look => ({
      W: 20, D: 14, H: 2.9, desk: M.matte('#ecebe6'), leg: M.matte('#2a2a2c'), chair: M.fabric('#2d3138'), light: '#f2f5ff', warm: false, ...o,
    });
    switch (t) {
      case 'tech': return L({ W: r.pick([20, 22]), D: 14, H: 3.3, floor: surface('floor_concrete', [1, 1], { color: '#c8c6c0', roughness: 0.35 }), wall: M.paint('#eef0f0'), ceiling: 'open', desk: M.oak('#f0e6d6'), leg: M.matte('#f2f2f2'), chair: M.fabric(r.pick(['#2d3138', '#3c5a7a', '#c45a3a'])) });
      case 'cubicle': return L({ W: 20, D: 15, H: 2.75, floor: M.carpetTile(r.pick(['#4a4d52', '#3d4650', '#55524c'])), wall: M.paint('#e6e6e2'), ceiling: 'drop', desk: M.matte('#d6d4ce'), chair: M.fabric('#22252a') });
      case 'law': return L({ W: 21, D: 15, H: 2.85, floor: M.carpet(r.pick(['#5a4636', '#3e3a46', '#4a3a30'])), wall: M.paint('#e8e0d2'), ceiling: 'plaster', desk: M.walnut('#c8b8a8'), leg: M.walnut('#9a8a7a'), chair: M.leather(r.pick(['#3a2418', '#1e1e20'])), light: '#fff1dc', warm: true });
      case 'creative': return L({ W: 20, D: 14, H: 3.6, floor: M.plank(), wall: surface('nyc_brick', [1, 1], { color: '#d8b8a8' }), ceiling: 'open', desk: M.oak('#ffffff'), leg: M.iron(), chair: M.fabric(r.pick(['#d8a23a', '#2f6a5a', '#b8452f'])), light: '#fff4e0', warm: true });
      case 'eighties': return L({ W: 20, D: 14, H: 2.6, floor: M.carpetTile('#6a5848'), wall: M.paint('#d8cdb8'), ceiling: 'drop', desk: M.walnut('#d8b890'), leg: M.matte('#8a7a68'), chair: M.fabric('#7a4a3a'), light: '#f8f4e8' });
      case 'dentist': return L({ W: 16, D: 12, H: 2.7, floor: mat('#e4e6e2', { rough: 0.35 }), wall: M.paint('#f2f4f2'), ceiling: 'drop', desk: M.matte('#f4f4f2'), chair: M.fabric('#5a8aa0') });
      case 'gym': return L({ W: 18, D: 13, H: 3.3, floor: mat('#2a2b2d', { rough: 0.95 }), wall: M.paint('#3a3d42'), ceiling: 'open', desk: M.matte('#1e1e20'), chair: M.fabric('#1e1e20') });
      case 'cowork': return L({ W: 20, D: 14, H: 3.1, floor: M.parquet(), wall: M.paint('#e9e4dc'), ceiling: 'plaster', desk: M.oak('#e8d8c0'), chair: M.fabric(r.pick(['#3a5a4a', '#5a4a6a', '#2d3138'])), light: '#fff4e4', warm: true });
    }
  }

  private col(x0: number, x1: number, z0: number, z1: number) {
    this.cols.push({ minX: Math.min(x0, x1), maxX: Math.max(x0, x1), minZ: Math.min(z0, z1), maxZ: Math.max(z0, z1) });
  }

  private *generate(cutaway: boolean, withLights: boolean) {
    const look = (this.look = this.lookFor(this.type));
    const { W, D, H } = look;
    const k = this.kit, r = this.rng;
    const x0 = -W / 2, x1 = W / 2, z0 = -D / 2, z1 = D / 2;
    const ex = x0 + 2.2; // entry door centre
    const spineZ = z1 - 4.0; // spine aisle centre line, 1.5 m wide
    this.spawn.pos.set(ex, 0, z1 - 1.2);
    this.doorway = { pos: new THREE.Vector3(ex, 0, z1), yaw: 0 };

    // ---- shell: floor, ceiling, walls (door gap), windows on the back wall
    k.flat(look.floor, W, D, 0, 0, 0);
    const T = 0.2;
    for (const [a, b] of [[x0, ex - 0.55], [ex + 0.55, x1]]) {
      k.box(look.wall, b - a, H, T, (a + b) / 2, 0, z1 + T / 2);
      this.col(a, b, z1, z1 + T);
    }
    k.box(look.wall, 1.1, H - 2.15, T, ex, 2.15, z1 + T / 2);
    for (const sx of [-1, 1]) {
      k.box(look.wall, T, H, D + 2 * T, sx * (W / 2 + T / 2), 0, 0);
      this.col(sx * W / 2, sx * (W / 2 + T), z0 - T, z1 + T);
    }
    k.box(look.wall, W, 0.75, T, 0, 0, z0 - T / 2);
    k.box(look.wall, W, 0.4, T, 0, H - 0.4, z0 - T / 2);
    this.col(x0, x1, z0 - T, z0);
    // the window band: bright glass between mullions (the city beyond reads as daylight)
    const view = M.viewPlane(); // [windowview] the real city goes on it (src/windowview.ts)
    k.unshadowed(() => {
      k.box(view, W, H - 1.15, 0.02, 0, 0.75, z0 - 0.12);
      for (let x = x0; x <= x1 + 0.01; x += 1.5) k.box(M.iron(), 0.06, H - 1.15, 0.08, x, 0.75, z0 - 0.08);
    });
    k.box(M.matte('#d8d6d0'), W, 0.03, 0.25, 0, 0.75, z0 + 0.12); // sill
    // the door leaf, open against the wall, and the exit
    k.at(ex - 0.5, 0, z1 - 0.05, -Math.PI / 2 + 0.15, () => F.doorLeaf(k, 0.95, 2.1, M.matte('#5a5e62')));
    this.ports.push({ box: new THREE.Box3(new THREE.Vector3(ex - 0.7, 0, z1 - 0.6), new THREE.Vector3(ex + 0.7, 2.4, z1 + 0.3)), label: 'Leave the suite', target: 'back' });
    if (!cutaway) this.ceiling(look, x0, x1, z0, z1);
    yield;

    // ---- front strip: reception, waiting, kitchenette
    const isOffice = this.type !== 'gym' && this.type !== 'dentist';
    this.reception(ex, z1, spineZ, this.type !== 'gym' ? x1 - 4.4 : x1 - 0.2);
    yield;
    if (this.type !== 'gym') this.kitchenette(x1 - 4.4, x1 - 0.2, z1, spineZ);
    yield;

    // ---- work area behind the spine
    const wz1 = spineZ - 0.75; // front edge of the work area (spine aisle is 1.5 m)
    let wx1 = x1 - 0.2;
    if (isOffice) {
      // glass meeting room at the back right
      const mw = r.pick([4.4, 4.8]), md = 4.0;
      this.meetingRoom(x1 - mw, x1, z0, z0 + md);
      wx1 = x1 - mw - 1.2;
      // a lounge corner in front of it: sofa, plant
      const lz = (z0 + md + wz1) / 2;
      if (wz1 - (z0 + md) > 2.2) {
        k.at(x1 - mw / 2, 0, lz, Math.PI, () => F.sofa(k, r, 2.0, M.fabric(r.pick(['#5a6a7a', '#7a5a4a', '#4a5a4a'])), M.black(), [M.fabric('#d8c8a8')]));
        this.col(x1 - mw / 2 - 1.05, x1 - mw / 2 + 1.05, lz - 0.45, lz + 0.45);
      }
    }
    yield;
    const area = { x0: x0 + 0.2, x1: wx1, z0: z0 + 0.3, z1: wz1 };
    switch (this.type) {
      case 'tech': yield* this.benching(area, 2.9, true); break;
      case 'cowork': yield* this.benching(area, 2.9, false); break;
      case 'cubicle': yield* this.cubicles(area, 2.2, 1.4, M.fabric('#8a9098'), false); break;
      case 'eighties': yield* this.cubicles(area, 2.4, 1.45, M.fabric('#c8b896'), true); break;
      case 'law': yield* this.law(area); break;
      case 'creative': yield* this.creative(area); break;
      case 'dentist': yield* this.dentist({ ...area, x1: x1 - 0.2 }); break;
      case 'gym': yield* this.gym({ ...area, x1: x1 - 0.2 }); break;
    }
    // ---- art on the side walls, plants in the corners
    this.art(x0, x1, z0, z1, spineZ);
    for (const [px, pz] of [[x0 + 0.5, z0 + 0.5], [x1 - 0.5, spineZ - 1.0], [x0 + 0.5, spineZ - 1.0]] as const) {
      // only where it leaves a 0.9 m way past it to everything around (walls excepted)
      const wall = (c: Rect) => c.maxX - c.minX > look.W - 1 || c.maxZ - c.minZ > look.D - 1;
      if (this.cols.some((c) => !wall(c) && px > c.minX - 1.25 && px < c.maxX + 1.25 && pz > c.minZ - 1.25 && pz < c.maxZ + 1.25)) continue;
      this.libItem('potted_plant_01', px, 0, pz, 0, (kk) => F.plant(kk, r, 1.3));
      this.col(px - 0.3, px + 0.3, pz - 0.3, pz + 0.3);
    }
    yield;

    // ---- lights: a fixed 8 (no shader recompiles between suites), within the light budget
    const nx = 4, nz = 2;
    if (withLights) for (let i = 0; i < nx; i++)
      for (let j = 0; j < nz; j++) {
        const l = new THREE.PointLight(look.light, (W * D) / 8 * (look.warm ? 0.55 : 0.65), Math.max(W / nx, D / nz) * 2.4, 2); // (brighter blew out the ceiling)
        l.position.set(x0 + (W / nx) * (i + 0.5), H * 0.62, z0 + (D / nz) * (j + 0.5)); // well below the ceiling: no hot spots on it
        this.group.add(l);
        this.lights.push(l);
      }
    this.finishInstances();
    k.finish(this.group);
  }

  private ceiling(look: Look, x0: number, x1: number, z0: number, z1: number) {
    const k = this.kit, W = x1 - x0, D = z1 - z0, H = look.H;
    k.unshadowed(() => {
      if (look.ceiling === 'drop') {
        k.box(M.dropCeiling(), W, 0.02, D, 0, H, 0);
        for (let x = x0 + 1.8; x < x1 - 1; x += 3.6) for (let z = z0 + 1.8; z < z1 - 1; z += 3.0) k.box(M.troffer(), 0.6, 0.012, 1.2, x, H - 0.012, z);
      } else if (look.ceiling === 'plaster') {
        k.box(M.ceiling(), W, 0.02, D, 0, H, 0);
        for (let x = x0 + 1.5; x < x1 - 1; x += 3) for (let z = z0 + 1.5; z < z1 - 1; z += 3) k.cyl(M.diffuser(), 0.09, 0.09, 0.02, x, H - 0.02, z, 16);
      } else {
        // open ceiling: dark deck, round ducts, pendant lines of light
        k.box(M.matte('#2e3034'), W, 0.02, D, 0, H + 0.4, 0);
        for (const z of [z0 + D * 0.3, z0 + D * 0.7]) k.rod(M.steel(), 0.2, W - 0.4, 0, H + 0.18, z, 'x', 16);
        for (let x = x0 + 2; x < x1 - 1; x += 4) for (const z of [z0 + D * 0.5]) {
          k.rod(M.black(), 0.008, 0.6, x, H - 0.1, z, 'z', 4);
          k.box(M.troffer(), 1.6, 0.05, 0.12, x, H - 0.45, z);
        }
      }
    });
  }

  /**
   * The front strip (between the front wall and the spine aisle): a reception desk facing the
   * entry aisle with a logo wall behind it, a coat rack by the door, a waiting sofa, a copier
   * station and recycling bins. `end`: where the kitchenette starts (nothing past it).
   */
  private reception(ex: number, z1: number, spineZ: number, end: number) {
    const k = this.kit, r = this.rng, look = this.look;
    const zf = spineZ + 0.75; // back edge of the strip (the spine aisle starts there)
    const front = this.type === 'law' ? M.walnut('#b8a898') : this.type === 'eighties' ? M.walnut('#d8b890') : this.type === 'gym' ? M.matte('#1a1a1c') : M.matte('#f2f1ee');
    // reception desk: long side along z, its front facing the entry aisle (-x)
    const dx = ex + 1.85, dz = (zf + z1) / 2, len = Math.min(2.2, z1 - zf - 0.7);
    k.box(front, 0.6, 1.05, len, dx, 0, dz);
    k.box(this.type === 'dentist' ? M.marble() : M.oak('#e8d8c0'), 0.75, 0.04, len + 0.1, dx + 0.05, 1.05, dz);
    k.box(look.desk, 0.7, 0.03, len, dx + 0.3, 0.71, dz); // the work top behind the counter
    this.col(dx - 0.3, dx + 0.65, dz - len / 2, dz + len / 2);
    this.chairs.push(new THREE.Matrix4().makeRotationY(-Math.PI / 2).setPosition(dx + 1.05, 0, dz));
    this.deskClutter(dx + 0.3, 0.74, dz, len - 0.4, 0.7, Math.PI / 2, this.type === 'eighties', { x0: dx - 0.05, x1: dx + 0.65, z0: dz - len / 2, z1: dz + len / 2, top: 0.74 });
    // the logo wall behind the receptionist, its face to the entry, the company name on it
    const lx = dx + 1.55, lw = z1 - zf - 0.3;
    const wallM = this.type === 'law' ? M.walnut('#8a7a6a') : this.type === 'creative' ? M.matte('#2a2c30') : this.type === 'tech' ? M.matte(r.pick(['#3a6a8a', '#2f6a5a', '#5a3a7a'])) : this.type === 'eighties' ? M.matte('#8a6a4a') : this.type === 'gym' ? M.matte('#c8452f') : M.oak('#d8c0a0');
    k.box(wallM, 0.15, Math.min(look.H, 2.7), lw, lx, 0, (zf + z1) / 2 + 0.15);
    this.col(lx - 0.08, lx + 0.08, zf + 0.15, z1);
    const name = r.pick(COMPANY[this.type]);
    const sm = new THREE.MeshStandardMaterial({ map: signTex(name, this.type === 'law' ? '#5a4a3a' : '#1a1c20', this.type === 'creative' ? '#f2c94c' : '#f2f2f0'), roughness: 0.4 });
    sm.userData.owned = true;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(2.4, lw - 0.3), 0.6), sm);
    sign.userData.owned = true;
    sign.position.set(lx - 0.08, 1.75, (zf + z1) / 2 + 0.15);
    sign.rotation.y = -Math.PI / 2;
    this.group.add(sign);
    // a coat rack against the left wall by the door
    const cx0 = -look.W / 2 + 0.35, cz0 = z1 - 1.7;
    k.cyl(M.iron(), 0.2, 0.22, 0.03, cx0, 0, cz0, 16);
    k.cyl(M.iron(), 0.018, 0.018, 1.75, cx0, 0, cz0, 8);
    for (let i = 0; i < 4; i++) k.at(cx0, 1.68, cz0, (i * Math.PI) / 2, () => k.boxM(M.iron(), 0.015, 0.015, 0.2, 0, 0, 0.08, new THREE.Euler(-0.6, 0, 0)));
    if (r.chance(0.7)) k.boxM(M.fabric(r.pick(['#2a2a2c', '#5a4a3a', '#3a4a5a'])), 0.42, 0.9, 0.16, cx0 + 0.08, 1.15, cz0, new THREE.Euler(0, 0.3, 0.05));
    this.col(cx0 - 0.25, cx0 + 0.25, cz0 - 0.25, cz0 + 0.25);
    // along the front wall, left to right: waiting sofa with a low table, the copier station, recycling bins
    let x = lx + 0.6;
    const fits = (w: number) => x + w <= end - 0.3;
    if (fits(2.4)) {
      const sx = x + 1.1;
      k.at(sx, 0, z1 - 0.5, Math.PI, () => F.sofa(k, r, 2.0, M.fabric(r.pick(['#5a6a7a', '#7a5a4a', '#4a5a4a', '#8a3a3a', '#c8b89a'])), M.black(), [M.fabric('#d8c8a8')]));
      this.col(sx - 1.05, sx + 1.05, z1 - 0.95, z1);
      const tz = z1 - 1.55;
      k.box(M.oak('#e8d8c0'), 1.0, 0.4, 0.5, sx, 0, tz);
      F.bookStack(k, r, sx - 0.2, 0.4, tz);
      this.col(sx - 0.5, sx + 0.5, tz - 0.25, tz + 0.25);
      this.seats.push(new THREE.Vector3(sx, 0, tz - 0.6));
      x += 2.6;
    }
    if (this.type !== 'gym' && fits(1.9)) {
      // copier: a big grey box with its control panel and paper drawers, a printer on a cabinet beside it
      const cx = x + 0.4, cz = z1 - 0.4;
      k.box(M.matte('#d8d8d4'), 0.65, 0.95, 0.65, cx, 0, cz);
      for (let i = 0; i < 3; i++) k.box(M.matte('#b8b8b4'), 0.6, 0.005, 0.01, cx, 0.2 + i * 0.22, cz - 0.33);
      k.box(M.matte('#c8c8c4'), 0.6, 0.12, 0.55, cx, 0.95, cz + 0.03);
      k.box(M.screenOn(), 0.18, 0.1, 0.01, cx + 0.15, 1.0, cz - 0.3);
      k.box(M.matte('#f6f5f0'), 0.21, 0.01, 0.297, cx - 0.1, 1.07, cz);
      const px = x + 1.25;
      k.box(M.matte('#c8c4bc'), 0.8, 0.72, 0.5, px, 0, cz + 0.05);
      k.box(M.matte('#2a2a2c'), 0.45, 0.3, 0.4, px, 0.72, cz + 0.05);
      k.box(M.matte('#f6f5f0'), 0.21, 0.04, 0.297, px - 0.25, 0.72, cz);
      this.col(x + 0.05, x + 1.7, z1 - 0.75, z1);
      x += 1.9;
    }
    if (fits(1.1)) {
      // recycling: paper (blue), cans and bottles (green), waste (grey)
      for (const [i, c] of (['#2a5aa8', '#2a8a4a', '#5a5a5c'] as const).entries()) {
        const bx = x + 0.18 + i * 0.36;
        k.box(M.matte(c), 0.32, 0.7, 0.38, bx, 0, z1 - 0.3);
        k.box(M.matte('#1a1a1c'), 0.33, 0.02, 0.39, bx, 0.7, z1 - 0.3);
      }
      this.col(x, x + 1.1, z1 - 0.5, z1);
      x += 1.2;
    }
  }

  private kitchenette(a: number, b: number, z1: number, spineZ: number) {
    const k = this.kit, look = this.look, r = this.rng;
    const cab = r.pick([M.painted('#f1eee6'), M.painted('#2f3d4a'), M.oak('#e8d8c0'), M.painted('#c9cfc6')]);
    const z = z1 - 0.33;
    k.box(cab, b - a - 0.75, 0.88, 0.62, (a + b - 0.75) / 2, 0, z);
    k.box(this.type === 'law' ? M.marble() : M.marble('#6a6a6a'), b - a - 0.75, 0.04, 0.65, (a + b - 0.75) / 2, 0.88, z - 0.01);
    k.box(M.chrome(), 0.45, 0.02, 0.35, a + 0.8, 0.9, z); // sink
    k.box(M.steel(), 0.72, 1.85, 0.68, b - 0.38, 0, z); // fridge
    k.box(cab, b - a - 0.75, 0.7, 0.35, (a + b - 0.75) / 2, 1.5, z1 - 0.18);
    k.box(M.black(), 0.3, 0.38, 0.34, a + 1.8, 0.92, z - 0.05); // coffee machine
    F.mug(k, r, a + 1.4, 0.92, z - 0.1);
    this.col(a, b, z1 - 0.7, z1);
    // a high table with stools in front
    const tz = (z1 - 0.7 + spineZ + 0.75) / 2;
    if (z1 - 0.7 - (spineZ + 0.75) > 1.6) {
      const tx = (a + b) / 2;
      k.cyl(look.leg, 0.04, 0.04, 1.02, tx, 0, tz, 10);
      k.cyl(look.desk, 0.4, 0.4, 0.04, tx, 1.02, tz, 24);
      this.col(tx - 0.45, tx + 0.45, tz - 0.45, tz + 0.45);
    }
  }

  private meetingRoom(a: number, b: number, c: number, d: number) {
    const k = this.kit, look = this.look, r = this.rng, H = look.H;
    this.rooms.push({ minX: a, maxX: b, minZ: c, maxZ: d });
    const mid = (a + b) / 2;
    // glass front with a 1.0 m door gap, glass side wall
    k.unshadowed(() => {
      k.box(M.glass(), mid - 0.5 - a, H, 0.02, (a + mid - 0.5) / 2, 0, d);
      k.box(M.glass(), b - mid - 0.5, H, 0.02, (mid + 0.5 + b) / 2, 0, d);
      k.box(M.glass(), 0.02, H, d - c, a, 0, (c + d) / 2);
      k.box(M.frosted(), b - a, 0.25, 0.022, mid, 1.0, d); // privacy band
    });
    for (const x of [a, mid - 0.5, mid + 0.5, b]) k.box(M.iron(), 0.04, H, 0.06, x, 0, d);
    this.col(a, mid - 0.5, d - 0.04, d + 0.04);
    this.col(mid + 0.5, b, d - 0.04, d + 0.04);
    this.col(a - 0.04, a + 0.04, c, d);
    // table and chairs, whiteboard on the side wall, a screen on the back wall
    const tw = Math.min(2.6, b - a - 1.8), td = 1.1, tz = (c + d) / 2 - 0.2;
    k.box(look.desk, tw, 0.04, td, mid, 0.72, tz);
    k.box(look.leg, 0.1, 0.72, 0.5, mid, 0, tz);
    this.col(mid - tw / 2, mid + tw / 2, tz - td / 2, tz + td / 2);
    for (let i = 0; i < 3; i++) for (const s of [-1, 1]) {
      const x = mid - tw / 2 + tw * (i + 0.5) / 3;
      this.chairs.push(new THREE.Matrix4().makeRotationY(s > 0 ? Math.PI : 0).setPosition(x, 0, tz + s * (td / 2 + 0.35)));
    }
    k.box(M.porcelain(), 0.02, 1.1, 1.8, a + 0.04, 0.95, tz);
    k.box(M.steel(), 0.04, 0.04, 1.8, a + 0.06, 0.95, tz);
    for (let i = 0; i < 4; i++) k.box(M.matte(r.pick(['#2a4a8a', '#a82a2a', '#2a7a3a'])), 0.004, 0.02, r.range(0.3, 0.9), a + 0.052, r.range(1.2, 1.9), tz + r.range(-0.6, 0.6));
    k.box(M.screen(), b - a > 4 ? 1.6 : 1.2, 0.9, 0.05, mid, 1.1, c + 0.05);
  }

  // ---------------------------------------------------------------- desks and their clutter

  /** a desk top at (x, z) of size w x d (rotY: 0 = you sit at +z facing -z), with clutter */
  private desk(x: number, z: number, w: number, d: number, rotY: number, crt = false) {
    const k = this.kit, look = this.look;
    k.at(x, 0, z, rotY, () => {
      k.box(look.desk, w, 0.03, d, 0, 0.71, 0);
      for (const sx of [-1, 1]) k.box(look.leg, 0.05, 0.71, d - 0.08, sx * (w / 2 - 0.04), 0, 0);
    });
    const c = Math.abs(Math.cos(rotY)), s = Math.abs(Math.sin(rotY));
    const hw = (w * c + d * s) / 2, hd = (w * s + d * c) / 2;
    this.col(x - hw, x + hw, z - hd, z + hd);
    const info: DeskInfo = { x0: x - hw, x1: x + hw, z0: z - hd, z1: z + hd, top: 0.74 };
    // the chair and the seat point in front of the desk
    const fx = Math.sin(rotY), fz = Math.cos(rotY);
    const cx = x + fx * (d / 2 + 0.45), cz = z + fz * (d / 2 + 0.45);
    this.chairs.push(new THREE.Matrix4().makeRotationY(rotY + Math.PI).setPosition(cx, 0, cz)); // (a chair faces its +z)
    this.seats.push(new THREE.Vector3(cx, 0, cz));
    this.deskClutter(x, 0.74, z, w, d, rotY, crt, info);
  }

  /** monitor, keyboard, papers, a mug and sometimes a library lamp / laptop / plant / frame, all on the top */
  private deskClutter(x: number, y: number, z: number, w: number, d: number, rotY: number, crt: boolean, info: DeskInfo) {
    const k = this.kit, r = this.rng;
    const di = this.desks.push(info) - 1;
    const local = (lx: number, lz: number): [number, number] => [x + lx * Math.cos(rotY) + lz * Math.sin(rotY), z - lx * Math.sin(rotY) + lz * Math.cos(rotY)];
    const note = (kind: string, lx: number, lz: number, sw: number, sd: number, h: number) => {
      const [px, pz] = local(lx, lz);
      const c = Math.abs(Math.cos(rotY)), s = Math.abs(Math.sin(rotY));
      this.clutter.push({ kind, x: px, z: pz, y, w: sw * c + sd * s, d: sw * s + sd * c, h, desk: di });
    };
    if (this.type === 'gym') return;
    // the screen (instanced), keyboard and mouse
    const sx = r.range(-0.1, 0.1);
    if (crt) {
      k.at(x, 0, z, rotY, () => {
        k.box(M.matte('#d8d0bc'), 0.4, 0.36, 0.42, sx, y, -d / 2 + 0.28);
        k.box(M.screen(), 0.3, 0.24, 0.005, sx, y + 0.06, -d / 2 + 0.495);
        k.box(M.matte('#d8d0bc'), 0.46, 0.03, 0.16, sx, y, d / 2 - 0.16);
      });
      note('crt', sx, -d / 2 + 0.28, 0.4, 0.42, 0.36);
    } else if (d < 0.6) {
      // a shallow place at a long table: a laptop, open
      k.at(x, 0, z, rotY, () => {
        k.box(M.matte('#b8bcc0'), 0.33, 0.015, 0.23, sx, y, 0.02);
        k.boxM(M.matte('#b8bcc0'), 0.33, 0.22, 0.008, sx, y + 0.11, -0.1, new THREE.Euler(-0.25, 0, 0));
      });
      note('laptop', sx, 0.0, 0.33, 0.27, 0.22);
    } else {
      const [mx, mz] = local(sx, -d / 2 + 0.25);
      this.screens.push(new THREE.Matrix4().makeRotationY(rotY).setPosition(mx, y, mz));
      note('monitor', sx, -d / 2 + 0.25, 0.6, 0.2, 0.46);
      k.at(x, 0, z, rotY, () => {
        k.box(M.matte('#2a2a2c'), 0.44, 0.018, 0.14, sx, y, d / 2 - 0.2);
        k.box(M.matte('#2a2a2c'), 0.06, 0.02, 0.1, sx + 0.32, y, d / 2 - 0.2);
      });
      note('keyboard', sx, d / 2 - 0.2, 0.44, 0.14, 0.018);
    }
    // papers (A4) and a mug
    const px = r.range(0.2, w / 2 - 0.2) * (r.chance(0.5) ? 1 : -1);
    k.at(x, 0, z, rotY, () => {
      const n = r.int(1, 4);
      for (let i = 0; i < n; i++) k.box(M.matte('#f6f5f0'), 0.21, 0.002, 0.297, px + r.range(-0.03, 0.03), y + i * 0.002, r.range(-0.05, 0.08), r.range(-0.3, 0.3));
    });
    note('papers', px, 0.02, 0.3, 0.33, 0.01);
    if (r.chance(0.7)) {
      const mxl = -px * 0.8;
      const [mx, mz] = local(mxl, 0.1);
      const id = r.pick([...GSO_IDS]);
      const s = OFFICE_LIB[id];
      this.libItem(id, mx, y, mz, rotY + r.range(-0.6, 0.6), (kk) => F.mug(kk, r, 0, 0, 0));
      note(id, mxl, 0.1, s[0], s[2], s[1]);
    }
    // library decor (real size, streamed when near): a desk lamp, a laptop, a small plant or a frame
    if (r.chance(0.35)) {
      const id = r.pick(['potted_plant_04', 'standing_picture_frame_01', 'alarm_clock_01']);
      const s = OFFICE_LIB[id];
      const lx = (w / 2 - s[0] / 2 - 0.03) * (px > 0 ? -1 : 1), lz = -d / 2 + s[2] / 2 + 0.03;
      const [hx, hz] = local(lx, lz);
      this.libItem(id, hx, y, hz, rotY);
      note(id, lx, lz, s[0], s[2], s[1]);
    }
  }

  /** a library model in a holder at real size; until it streams in, a box of its size stands in */
  /**
   * A library model in a holder at real size (OFFICE_LIB sizes). Until it streams in (update(), when
   * you come within 9 m) a procedural stand-in of the same size is drawn in the holder.
   */
  private libItem(id: string, x: number, y: number, z: number, rotY: number, standIn?: (k: Kit) => void) {
    const o = new THREE.Group();
    o.position.set(x, y, z);
    o.rotation.y = rotY;
    const s = OFFICE_LIB[id];
    const kk = new Kit();
    if (standIn) standIn(kk);
    else if (s) kk.box(M.matte('#8a8680'), s[0] * 0.9, s[1] * 0.9, s[2] * 0.9);
    kk.finish(o, false);
    this.group.add(o);
    this.holders.push({ o, id, done: false });
  }

  /** stream one library model into its holder (the suite's AbortController drops it if the suite goes) */
  private async stream(h: { o: THREE.Group; id: string }) {
    const src = GSO_IDS.has(h.id) ? 'gso' : 'polyhaven';
    const e = (await catalog(src)).get(h.id);
    if (!e || h.o.userData.disposed || !libEnabled) return;
    const m = await loadLibraryModel(e, { signal: this.loads.signal, quality: 'low' }).catch(() => null);
    if (!m || h.o.userData.disposed) return;
    for (const c of [...h.o.children]) {
      c.removeFromParent();
      disposeTree(c);
    }
    h.o.add(m);
  }

  // ---------------------------------------------------------------- layouts per type

  /** columns of double-sided benches running back from the spine (tech, co-working) */
  private *benching(a: Rect | { x0: number; x1: number; z0: number; z1: number }, colW: number, booths: boolean) {
    const A = a as { x0: number; x1: number; z0: number; z1: number };
    const k = this.kit, r = this.rng;
    const aisle = 1.2, seat = r.pick([1.4, 1.6]);
    let x = A.x0 + 0.3;
    // phone booths along the left wall
    if (booths) {
      for (let z = A.z0 + 0.2; z + 1.1 < A.z1 - 0.2; z += 1.3) this.booth(A.x0 + 0.55, z + 0.55);
      x = A.x0 + 1.1 + aisle;
    }
    let col = 0;
    for (; x + colW <= A.x1 + 0.01; x += colW + aisle, col++) {
      const cx = x + colW / 2;
      // a cowork floor alternates benches with lounge columns
      if (!booths && col % 3 === 2) {
        for (let z = A.z0 + 1.0; z + 1.0 < A.z1; z += 2.6) {
          k.at(cx, 0, z + 0.5, Math.PI / 2, () => F.sofa(k, r, 1.8, M.fabric(r.pick(['#8a6a4a', '#4a6a7a', '#7a4a5a'])), M.black(), [M.fabric('#e8dcc4')]));
          this.col(cx - 0.45, cx + 0.45, z - 0.45, z + 1.45);
        }
        continue;
      }
      const n = Math.floor((A.z1 - A.z0 - 0.6) / seat);
      for (let i = 0; i < n; i++) {
        const z = A.z1 - 0.3 - seat * (i + 0.5);
        for (const s of [-1, 1]) this.desk(cx + s * 0.375, z, seat - 0.05, 0.75, s > 0 ? Math.PI / 2 : -Math.PI / 2);
      }
      k.box(M.matte('#d8d8d4'), 0.03, 0.4, n * seat - 0.1, cx, 0.74, A.z1 - 0.3 - (n * seat) / 2); // privacy screen
      yield;
    }
  }

  private booth(x: number, z: number) {
    const k = this.kit;
    k.box(M.matte('#3a4a5a'), 1.0, 2.3, 0.05, x, 0, z - 0.5);
    for (const s of [-1, 1]) k.box(M.matte('#3a4a5a'), 0.05, 2.3, 1.0, x + s * 0.5, 0, z);
    k.box(M.matte('#3a4a5a'), 1.0, 0.1, 1.0, x, 2.2, z);
    k.unshadowed(() => k.box(M.glass(), 1.0, 2.2, 0.02, x, 0, z + 0.5));
    k.box(M.oak('#e8d8c0'), 0.7, 0.03, 0.35, x, 1.05, z - 0.3);
    this.col(x - 0.55, x + 0.55, z - 0.55, z + 0.55);
  }

  /** back-to-back cubicles in columns, open to the aisles at both sides */
  private *cubicles(A: { x0: number; x1: number; z0: number; z1: number }, cs: number, ph: number, panel: THREE.Material, crt: boolean) {
    const k = this.kit;
    const aisle = 1.2;
    // an aisle on both sides of every column (the cubicles open onto them)
    for (let x = A.x0 + aisle; x + 2 * cs <= A.x1 + 0.01; x += 2 * cs + aisle) {
      const n = Math.floor((A.z1 - A.z0 - 0.4) / cs);
      const zb = A.z1 - 0.2 - n * cs;
      // spine panel between the two rows and the dividers between cubicles
      k.box(panel, 0.06, ph, n * cs, x + cs, 0, zb + (n * cs) / 2);
      this.col(x + cs - 0.04, x + cs + 0.04, zb, zb + n * cs);
      for (let i = 0; i <= n; i++) {
        const z = zb + i * cs;
        k.box(panel, 2 * cs, ph, 0.06, x + cs, 0, z);
        this.col(x, x + 2 * cs, z - 0.04, z + 0.04);
      }
      for (let i = 0; i < n; i++) {
        const zc = zb + (i + 0.5) * cs;
        // each cubicle: a desk along the spine panel, open to the aisle
        for (const s of [-1, 1]) this.desk(x + cs + s * (0.03 + 0.375), zc, cs - 0.3, 0.75, s > 0 ? Math.PI / 2 : -Math.PI / 2, crt);
      }
      yield;
    }
  }

  /** private window offices along the back wall, a corridor, the admin pool in the core */
  private *law(A: { x0: number; x1: number; z0: number; z1: number }) {
    const k = this.kit, r = this.rng, look = this.look;
    const od = 3.6, ow = 3.2;
    const wood = M.walnut('#b8a898');
    // walnut panelling on the side walls
    for (const sx of [-1, 1]) k.box(wood, 0.02, 1.0, this.look.D - 0.2, sx * (look.W / 2 - 0.012), 0, 0);
    const n = Math.floor((A.x1 - A.x0) / ow);
    for (let i = 0; i < n; i++) {
      const a = A.x0 + i * ow, b = a + ow, c = A.z0 - 0.3, d = c + od;
      this.rooms.push({ minX: a, maxX: b, minZ: c, maxZ: d });
      // front wall: wood with a door gap and a glass sidelight; partition walls between offices
      const door = a + 0.4;
      k.box(wood, b - (door + 1.4), look.H, 0.12, (door + 1.4 + b) / 2, 0, d);
      k.unshadowed(() => k.box(M.frosted(), 0.4, look.H - 0.2, 0.04, door + 1.2, 0, d));
      k.box(wood, 1.0, look.H - 2.15, 0.12, door + 0.5, 2.15, d);
      this.col(door + 1.0, b, d - 0.06, d + 0.06);
      this.col(a, door, d - 0.06, d + 0.06);
      k.box(wood, door - a, look.H, 0.12, (a + door) / 2, 0, d);
      if (i > 0) { k.box(look.wall, 0.12, look.H, od, a, 0, (c + d) / 2); this.col(a - 0.06, a + 0.06, c, d); }
      // desk facing the door, a credenza, guest chairs, a bookcase
      this.desk((a + b) / 2, c + 1.3, 1.6, 0.8, 0);
      k.at(b - 0.5, 0, c + 2.6, -Math.PI / 2, () => F.bookcase(k, r, 0.9, 2.0, wood, r.int(0, 9)));
      this.col(b - 0.7, b - 0.3, c + 2.1, c + 3.1);
      for (const s of [-1, 1]) {
        const gx = (a + b) / 2 + s * 0.4, gz = c + 2.55;
        k.at(gx, 0, gz, Math.PI, () => F.armchair(k, look.chair, wood));
      }
      yield;
    }
    // the admin pool: pairs of desks facing each other in columns from the corridor to the spine
    const pz0 = A.z0 + od + 1.4, aisle = 1.3;
    for (let x = A.x0 + 0.4; x + 2.8 <= A.x1 + 0.01; x += 2.8 + aisle) {
      const nrow = Math.floor((A.z1 - pz0 - 0.2) / 1.7);
      for (let j = 0; j < nrow; j++) {
        const z = pz0 + 0.9 + j * 1.7;
        this.desk(x + 0.7, z, 1.4, 0.7, -Math.PI / 2);
        this.desk(x + 2.1, z, 1.4, 0.7, Math.PI / 2);
      }
      yield;
    }
  }

  /** long communal tables, a pinboard wall, a sofa corner */
  private *creative(A: { x0: number; x1: number; z0: number; z1: number }) {
    const k = this.kit, r = this.rng, look = this.look;
    // pinboard wall: cork with cards and photos on the left wall
    const cork = mat('#b8925e', { rough: 0.95 });
    k.box(cork, 0.03, 1.4, 6, A.x0 - 0.17, 0.9, (A.z0 + A.z1) / 2);
    for (let i = 0; i < 40; i++) k.box(M.matte(r.pick(['#f6f5f0', '#f2d34a', '#7ac0e0', '#f08a8a', '#2a2a2c'])), 0.004, r.range(0.1, 0.25), r.range(0.1, 0.3), A.x0 - 0.15, r.range(1.0, 2.1), (A.z0 + A.z1) / 2 + r.range(-2.8, 2.8));
    const aisle = 1.3, colW = 0.9 + 1.4;
    for (let x = A.x0 + 0.6; x + colW <= A.x1 + 0.01; x += colW + aisle) {
      const cx = x + colW / 2, len = Math.min(5, A.z1 - A.z0 - 1.2), z = A.z1 - 0.4 - len / 2;
      k.box(look.desk, 0.9, 0.05, len, cx, 0.72, z);
      for (const zz of [z - len / 2 + 0.2, z + len / 2 - 0.2]) k.box(look.leg, 0.8, 0.72, 0.08, cx, 0, zz);
      this.col(cx - 0.45, cx + 0.45, z - len / 2, z + len / 2);
      const n = Math.floor(len / 1.2);
      for (let i = 0; i < n; i++) for (const s of [-1, 1]) {
        const zz = z - len / 2 + 1.2 * (i + 0.5);
        const ry = s > 0 ? Math.PI / 2 : -Math.PI / 2;
        this.chairs.push(new THREE.Matrix4().makeRotationY(ry + Math.PI).setPosition(cx + s * 0.85, 0, zz));
        this.seats.push(new THREE.Vector3(cx + s * 0.85, 0, zz));
        this.deskClutter(cx + s * 0.225, 0.77, zz, 1.0, 0.45, ry, false, { x0: cx + (s > 0 ? 0 : -0.45), x1: cx + (s > 0 ? 0.45 : 0), z0: zz - 0.5, z1: zz + 0.5, top: 0.77 });
      }
      yield;
    }
  }

  /** a waiting room at the front, treatment rooms with dental chairs at the back */
  private *dentist(A: { x0: number; x1: number; z0: number; z1: number }) {
    const k = this.kit, r = this.rng, look = this.look;
    const rw = 3.2, rd = 3.4;
    const n = Math.floor((A.x1 - A.x0) / rw);
    for (let i = 0; i < n; i++) {
      const a = A.x0 + i * rw, b = a + rw, c = A.z0 - 0.3, d = c + rd;
      this.rooms.push({ minX: a, maxX: b, minZ: c, maxZ: d });
      const door = (a + b) / 2;
      k.box(look.wall, door - 0.55 - a, look.H, 0.12, (a + door - 0.55) / 2, 0, d);
      k.box(look.wall, b - door - 0.55, look.H, 0.12, (door + 0.55 + b) / 2, 0, d);
      this.col(a, door - 0.55, d - 0.06, d + 0.06);
      this.col(door + 0.55, b, d - 0.06, d + 0.06);
      if (i > 0) { k.box(look.wall, 0.12, look.H, rd, a, 0, (c + d) / 2); this.col(a - 0.06, a + 0.06, c, d); }
      // the dental chair: base, reclined seat and back, the lamp arm, a stool, a cabinet run
      const cx = (a + b) / 2, cz = c + 1.6;
      k.box(M.porcelain(), 0.5, 0.45, 0.6, cx, 0, cz);
      k.boxM(look.chair, 0.6, 0.12, 1.1, cx, 0.55, cz + 0.1, new THREE.Euler(0.05, 0, 0));
      k.boxM(look.chair, 0.55, 0.12, 0.8, cx, 0.85, cz - 0.75, new THREE.Euler(0.9, 0, 0));
      k.cyl(M.chrome(), 0.03, 0.03, 1.9, cx + 0.7, 0, cz - 0.6, 8);
      k.box(M.porcelain(), 0.35, 0.12, 0.25, cx + 0.45, 1.85, cz - 0.3);
      this.col(cx - 0.35, cx + 0.35, cz - 1.2, cz + 0.7);
      k.box(M.painted('#f1eee6'), rw - 0.4, 0.88, 0.55, cx, 0, c + 0.3);
      k.box(M.marble(), rw - 0.4, 0.03, 0.58, cx, 0.88, c + 0.3);
      this.col(a + 0.2, b - 0.2, c, c + 0.6);
      this.seats.push(new THREE.Vector3(cx - 0.8, 0, cz + 0.3));
      yield;
    }
    // waiting: chairs facing each other and a low table, magazines
    const wz = A.z0 + rd + 2.0, wx = A.x0 + 3;
    for (const s of [-1, 1]) for (let i = 0; i < 3; i++) {
      const x = wx + i * 0.65, z = wz + s * 0.9;
      k.at(x, 0, z, s > 0 ? Math.PI : 0, () => F.armchair(k, look.chair, M.matte('#d8d8d4')));
      this.col(x - 0.3, x + 0.3, z - 0.3, z + 0.3);
    }
    k.box(M.oak('#e8d8c0'), 1.8, 0.4, 0.6, wx + 0.65, 0, wz);
    this.col(wx - 0.25, wx + 1.55, wz - 0.3, wz + 0.3);
    void r;
  }

  /** treadmills along the windows, a rack of weights, benches, a mirror wall */
  private *gym(A: { x0: number; x1: number; z0: number; z1: number }) {
    const k = this.kit, r = this.rng, look = this.look;
    // rubber mats and a mirror wall on the right
    k.box(M.mirror(), 0.02, 2.2, look.D - 3, look.W / 2 - 0.02, 0.2, -1);
    for (let x = A.x0 + 0.6; x + 0.9 < A.x1 - 0.6; x += 1.5) {
      const z = A.z0 + 1.0;
      k.box(M.matte('#1a1a1c'), 0.8, 0.2, 1.9, x + 0.45, 0, z);
      k.box(M.matte('#2a2a2c'), 0.06, 1.3, 0.06, x + 0.1, 0, z + 0.8);
      k.box(M.matte('#2a2a2c'), 0.06, 1.3, 0.06, x + 0.8, 0, z + 0.8);
      k.box(M.screen(), 0.7, 0.3, 0.1, x + 0.45, 1.3, z + 0.8);
      this.col(x, x + 0.9, z - 0.95, z + 0.95);
      this.seats.push(new THREE.Vector3(x + 0.45, 0, z + 1.6));
    }
    yield;
    // dumbbell rack and benches in the middle
    const rz = (A.z0 + 3.4 + A.z1) / 2;
    k.box(M.iron(), 3.0, 0.9, 0.6, A.x0 + 2.5, 0, rz);
    for (let i = 0; i < 10; i++) for (const y of [0.5, 0.85]) k.rod(M.black(), 0.06 + i * 0.006, 0.3, A.x0 + 1.2 + i * 0.28, y, rz, 'z', 10);
    this.col(A.x0 + 1, A.x0 + 4, rz - 0.3, rz + 0.3);
    for (let i = 0; i < 3; i++) {
      const x = A.x0 + 6 + i * 2.6;
      if (x > A.x1 - 1.5) break;
      k.box(M.leather('#1e1e20'), 0.3, 0.45, 1.2, x, 0, rz);
      k.box(M.iron(), 1.4, 0.04, 0.04, x, 1.2, rz - 0.4);
      this.col(x - 0.7, x + 0.7, rz - 0.6, rz + 0.6);
      this.seats.push(new THREE.Vector3(x + 1.3, 0, rz));
    }
    void r;
  }

  /** framed prints and canvases on the side walls (refcounted painting textures, own materials) */
  /**
   * Art on the side walls: framed prints and paintings from the library (Poly Haven frames with their
   * artworks, streamed when near; a painted canvas of the same size stands in), and larger painted
   * canvases (refcounted painting textures, own materials).
   */
  private art(x0: number, x1: number, z0: number, z1: number, spineZ: number) {
    const r = this.rng, k = this.kit;
    const frame = this.type === 'law' ? M.walnut('#8a7a6a') : r.pick([M.black(), M.oak('#e8d8c0'), M.matte('#f4f4f2')]);
    const lib = this.type === 'law' || this.type === 'eighties' || this.type === 'dentist'
      ? ['fancy_picture_frame_01', 'fancy_picture_frame_02', 'hanging_picture_frame_02', 'hanging_picture_frame_03']
      : ['hanging_picture_frame_01', 'hanging_picture_frame_02', 'hanging_picture_frame_03'];
    const n = this.type === 'law' ? 5 : this.type === 'gym' ? 1 : r.int(3, 5);
    for (let i = 0; i < n; i++) {
      const left = i % 2 === 0 && this.type !== 'creative';
      const wx = left ? x0 + 0.02 : x1 - 0.02;
      if (!left && this.type === 'gym') continue;
      const z = r.range(z0 + 1.5, spineZ - 1) + (i >> 1) * 0.1;
      const rot = left ? Math.PI / 2 : -Math.PI / 2;
      const paint = () => {
        const m = new THREE.MeshStandardMaterial({ map: paintingTex(r.int(0, 1e6)), roughness: 0.7 });
        m.userData.owned = true;
        return m;
      };
      if (i % 2 === 1 || this.type === 'law') {
        const id = r.pick(lib), s = OFFICE_LIB[id];
        const y = 1.6 - s[1] / 2;
        this.libItem(id, wx, y, z, rot, (kk) => F.picture(kk, paint(), s[0] - 0.06, s[1] - 0.06, 0, s[1] / 2, s[2] / 2, frame));
        continue;
      }
      const w = r.range(0.7, 1.3), h = w * r.range(0.65, 1.0);
      const art = paint();
      k.at(wx, 0, z, rot, () => F.picture(k, art, w, h, 0, 1.55 + h / 2, 0.02, frame));
    }
  }

  /** the chairs and screens as InstancedMeshes (one per material of the shared part geometry) */
  private finishInstances() {
    const look = this.look;
    const put = (key: string, build: (k: Kit) => void, list: THREE.Matrix4[]) => {
      if (!list.length) return;
      for (const p of parts(key, build)) {
        const im = new THREE.InstancedMesh(p.geo, p.mat, list.length);
        list.forEach((m, i) => im.setMatrixAt(i, m));
        im.castShadow = true;
        im.receiveShadow = true;
        im.computeBoundingSphere();
        this.group.add(im);
      }
    };
    const chair = this.type === 'law' ? 'exec' : 'task'; // (a wingback at a 1980s cubicle read wrong)
    put(`chair:${chair}:${look.chair.uuid}`, (k) => (chair === 'task' ? F.officeChair(k, look.chair) : F.armchair(k, look.chair, M.walnut('#9a8a7a'))), this.chairs);
    put('monitor', (k) => {
      // F.monitor without its keyboard (that is drawn per desk): foot, neck, panel, lit screen
      k.box(M.black(), 0.22, 0.012, 0.16, 0, 0, 0);
      k.box(M.black(), 0.04, 0.16, 0.02, 0, 0.01, -0.03);
      k.box(M.black(), 0.6, 0.35, 0.025, 0, 0.11, -0.01);
      k.box(M.screenOn(), 0.58, 0.33, 0.002, 0, 0.12, 0.003);
    }, this.screens);
  }
}
