import * as THREE from 'three';
import type { Env, Level, LevelDesc, Portal, Rect } from '../level';
import { disposeTree, finishBuilding } from '../level';
import { Kit } from './kit';
import { M } from './mats';
import * as F from './furniture';
import { LIB, fillHolder } from './lib';
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
  private chairs: THREE.Matrix4[] = [];
  private screens: THREE.Matrix4[] = [];
  private lights: THREE.PointLight[] = [];

  constructor(desc: Extract<LevelDesc, { kind: 'interior' }>, opts: { staged?: boolean; cutaway?: boolean } = {}) {
    this.type = (OFFICE_TYPES as readonly string[]).includes(desc.office ?? '') ? (desc.office as OfficeType) : 'cubicle';
    this.rng = new Rng(hashN(desc.seed, 991));
    this.name = desc.name;
    this.group.name = `office:${this.type}`;
    this.env = {
      skyTop: '#1a1612', skyBottom: '#2a241e', stars: false, fog: null, fogNear: 0, fogFar: 0, sun: null,
      hemi: { sky: '#f4f6ff', ground: '#5a5a58', intensity: 0.5 }, ambient: 0.06, envIntensity: 0.4, exposure: 1.0,
    };
    this.staging = this.generate(!!opts.cutaway);
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
        void fillHolder(h.o, h.id);
      }
    }
  }
  dispose() {
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

  private *generate(cutaway: boolean) {
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
    const view = mat('#cfe0ee', { rough: 0.1, emissive: '#b8d0e8', ei: 0.9 });
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
    this.reception(ex, z1, spineZ);
    yield;
    const isOffice = this.type !== 'gym' && this.type !== 'dentist';
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
      case 'eighties': yield* this.cubicles(area, 2.4, 1.6, M.fabric('#b8a88a'), true); break;
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
      this.libItem('potted_plant_01', px, 0, pz, 0, () => k.at(px, 0, pz, 0, () => F.plant(k, r, 1.3)));
      this.col(px - 0.3, px + 0.3, pz - 0.3, pz + 0.3);
    }
    yield;

    // ---- lights: a fixed 8 (no shader recompiles between suites), within the light budget
    const nx = 4, nz = 2;
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < nz; j++) {
        const l = new THREE.PointLight(look.light, (W * D) / 8 * (look.warm ? 0.9 : 1.1), Math.max(W / nx, D / nz) * 2.4, 2);
        l.position.set(x0 + (W / nx) * (i + 0.5), H - 0.5, z0 + (D / nz) * (j + 0.5));
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
        for (const z of [z0 + D * 0.3, z0 + D * 0.7]) k.rod(M.steel(), 0.28, W - 0.4, 0, H + 0.05, z, 'x', 16);
        for (let x = x0 + 2; x < x1 - 1; x += 4) for (const z of [z0 + D * 0.5]) {
          k.rod(M.black(), 0.008, 0.6, x, H - 0.1, z, 'z', 4);
          k.box(M.troffer(), 1.6, 0.05, 0.12, x, H - 0.45, z);
        }
      }
    });
  }

  private reception(ex: number, z1: number, spineZ: number) {
    const k = this.kit, r = this.rng, look = this.look;
    // the desk to the right of the entry aisle, facing the door
    const dx = ex + 2.6, dz = z1 - 1.7;
    const front = this.type === 'law' ? M.walnut('#b8a898') : this.type === 'eighties' ? M.walnut('#d8b890') : this.type === 'gym' ? M.matte('#1a1a1c') : M.matte('#f2f1ee');
    k.box(front, 2.2, 1.05, 0.6, dx, 0, dz);
    k.box(this.type === 'dentist' ? M.marble() : M.oak('#e8d8c0'), 2.3, 0.04, 0.75, dx, 1.05, dz - 0.05);
    this.col(dx - 1.15, dx + 1.15, dz - 0.4, dz + 0.3);
    this.chairs.push(new THREE.Matrix4().makeRotationY(0).setPosition(dx, 0, dz - 0.9));
    this.deskClutter(dx - 0.5, 0.74, dz - 0.15, 1.2, 0.4, 0, true, { x0: dx - 1.15, x1: dx + 1.15, z0: dz - 0.42, z1: dz + 0.2, top: 0.74 });
    // the company name on the wall behind (refcounted sign texture, freed with the suite)
    const name = r.pick(COMPANY[this.type]);
    const sm = new THREE.MeshStandardMaterial({ map: signTex(name, this.type === 'gym' ? '#1a1a1c' : '#2a2c30', this.type === 'creative' ? '#f2c94c' : '#f2f2f0'), roughness: 0.4 });
    sm.userData.owned = true;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.6), sm);
    sign.userData.owned = true;
    sign.position.set(dx, Math.min(look.H - 0.6, 2.2), z1 - 0.02);
    sign.rotation.y = Math.PI;
    this.group.add(sign);
    // waiting chairs along the front wall
    const wn = this.type === 'dentist' ? 5 : 3;
    for (let i = 0; i < wn; i++) {
      const cx = dx + 1.8 + i * 0.65, cz = z1 - 0.45;
      if (cx > look.W / 2 - 4.6 && this.type !== 'gym') break;
      k.at(cx, 0, cz, Math.PI, () => F.diningChair(k, M.matte('#2a2a2c'), look.chair));
      this.col(cx - 0.25, cx + 0.25, cz - 0.25, cz + 0.25);
    }
    void spineZ;
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
      F.mug(k, r, mx, y, mz);
      note('mug', mxl, 0.1, 0.085, 0.085, 0.095);
    }
    // library decor (real size, streamed when near): a desk lamp, a laptop, a small plant or a frame
    if (r.chance(0.35)) {
      const id = r.pick(['potted_plant_04', 'standing_picture_frame_01', 'alarm_clock_01']);
      const s = LIB[id];
      const lx = (w / 2 - s[0] / 2 - 0.03) * (px > 0 ? -1 : 1), lz = -d / 2 + s[2] / 2 + 0.03;
      const [hx, hz] = local(lx, lz);
      this.libItem(id, hx, y, hz, rotY);
      note(id, lx, lz, s[0], s[2], s[1]);
    }
  }

  /** a library model in a holder at real size; until it streams in, a box of its size stands in */
  private libItem(id: string, x: number, y: number, z: number, rotY: number, standIn?: () => void) {
    const o = new THREE.Group();
    o.position.set(x, y, z);
    o.rotation.y = rotY;
    const s = LIB[id];
    if (standIn) standIn();
    else if (s) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(s[0] * 0.9, s[1] * 0.9, s[2] * 0.9).translate(0, (s[1] * 0.9) / 2, 0), M.matte('#8a8680'));
      b.userData.owned = true;
      o.add(b);
    }
    this.group.add(o);
    this.holders.push({ o, id, done: false });
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
  private art(x0: number, x1: number, z0: number, z1: number, spineZ: number) {
    const r = this.rng, k = this.kit;
    const frame = this.type === 'law' ? M.walnut('#8a7a6a') : r.pick([M.black(), M.oak('#e8d8c0'), M.matte('#f4f4f2')]);
    const n = this.type === 'law' ? 4 : this.type === 'gym' ? 1 : r.int(2, 4);
    for (let i = 0; i < n; i++) {
      const left = i % 2 === 0 && this.type !== 'creative';
      const wx = left ? x0 + 0.02 : x1 - 0.02;
      if (!left && this.type === 'gym') continue;
      const z = r.range(z0 + 1.5, spineZ - 1) + (i >> 1) * 0.1;
      const w = r.range(0.6, 1.2), h = w * r.range(0.65, 1.1);
      const art = new THREE.MeshStandardMaterial({ map: paintingTex(r.int(0, 1e6)), roughness: 0.7 });
      art.userData.owned = true;
      k.at(wx, 0, z, left ? Math.PI / 2 : -Math.PI / 2, () => F.picture(k, art, w, h, 0, 1.55 + h / 2, 0.02, frame));
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
    const chair = this.type === 'law' || this.type === 'eighties' ? 'exec' : 'task';
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
