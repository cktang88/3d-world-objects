import * as THREE from 'three';
import { Rng, hashN, paintingName } from './rng';
import { pickModel, spawn, normScale, scaleTo, type ModelEntry } from './assets';
import { box, cyl, plane, mat, glow, footprint, rectBox3, blob } from './build';
import { woodFloorTex, tileFloorTex, carpetTex, wallpaperTex, rugTex, paintingTex, signTex } from './textures';
import { surface } from './pbr';
import { BIOMES, ROLE_BIOMES } from './biomes';
import type { Env, Level, LevelDesc, Portal, Rect } from './level';
import { disposeTree, overlaps, rect } from './level';

const H = 3.2; // ceiling height
const T = 0.16; // wall thickness
const DOOR = 1.25;

interface Room {
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

const STYLE_ROOMS: Record<string, string[]> = {
  house: ['living', 'kitchen', 'bedroom', 'bathroom', 'kids', 'study', 'bedroom'],
  apartment: ['living', 'kitchen', 'bedroom', 'bathroom', 'bedroom', 'study'],
  office: ['office', 'meeting', 'office', 'storage', 'kitchen', 'office', 'gallery'],
  shop: ['shop', 'shop', 'storage', 'office'],
  museum: ['gallery', 'gallery', 'gallery', 'gallery', 'gallery', 'storage'],
  workshop: ['workshop', 'storage', 'workshop', 'office', 'kitchen'],
  library: ['library', 'library', 'study', 'gallery', 'library'],
};

interface Spec {
  role: string;
  where: 'wall' | 'center' | 'free' | 'corner';
  n: [number, number];
  on?: string[];
  onN?: [number, number];
  chairs?: [number, number];
}

const ROOMS: Record<string, { floor: 'wood' | 'tile' | 'carpet'; items: Spec[]; rug?: boolean; paintings: [number, number] }> = {
  living: {
    floor: 'wood', rug: true, paintings: [1, 3],
    items: [
      { role: 'sofa', where: 'wall', n: [1, 2] },
      { role: 'table', where: 'center', n: [1, 1], on: ['tableware', 'food', 'stationery', 'toy'], onN: [1, 3] },
      { role: 'storage', where: 'wall', n: [1, 2], on: ['electronics', 'plant', 'toy', 'tableware'], onN: [1, 2] },
      { role: 'electronics', where: 'wall', n: [0, 1] },
      { role: 'lamp', where: 'corner', n: [1, 2] },
      { role: 'plant', where: 'corner', n: [1, 2] },
      { role: 'instrument', where: 'wall', n: [0, 1] },
      { role: 'chair', where: 'wall', n: [0, 2] },
    ],
  },
  kitchen: {
    floor: 'tile', paintings: [0, 1],
    items: [
      { role: 'appliance', where: 'wall', n: [2, 4], on: ['tableware', 'food'], onN: [0, 1] },
      { role: 'storage', where: 'wall', n: [1, 2], on: ['tableware', 'food'], onN: [1, 3] },
      { role: 'table', where: 'center', n: [1, 1], on: ['tableware', 'food', 'tableware'], onN: [2, 5], chairs: [2, 4] },
      { role: 'container', where: 'corner', n: [0, 2] },
      { role: 'plant', where: 'corner', n: [0, 1] },
    ],
  },
  bedroom: {
    floor: 'carpet', rug: true, paintings: [1, 2],
    items: [
      { role: 'bed', where: 'wall', n: [1, 1] },
      { role: 'storage', where: 'wall', n: [1, 2], on: ['lamp', 'stationery', 'toy', 'electronics'], onN: [1, 2] },
      { role: 'lamp', where: 'corner', n: [0, 1] },
      { role: 'chair', where: 'wall', n: [0, 1] },
      { role: 'plant', where: 'corner', n: [0, 1] },
      { role: 'sports', where: 'free', n: [0, 1] },
    ],
  },
  bathroom: {
    floor: 'tile', paintings: [0, 0],
    items: [
      { role: 'bathroom', where: 'wall', n: [2, 3] },
      { role: 'container', where: 'corner', n: [0, 1] },
      { role: 'plant', where: 'corner', n: [0, 1] },
    ],
  },
  kids: {
    floor: 'carpet', rug: true, paintings: [1, 2],
    items: [
      { role: 'bed', where: 'wall', n: [1, 1] },
      { role: 'storage', where: 'wall', n: [1, 1], on: ['toy', 'toy', 'stationery'], onN: [1, 3] },
      { role: 'table', where: 'center', n: [0, 1], on: ['toy', 'stationery'], onN: [1, 3], chairs: [1, 2] },
      { role: 'toy', where: 'free', n: [3, 7] },
      { role: 'sports', where: 'free', n: [1, 2] },
      { role: 'craft', where: 'free', n: [0, 2] },
    ],
  },
  study: {
    floor: 'wood', rug: true, paintings: [1, 2],
    items: [
      { role: 'table', where: 'wall', n: [1, 1], on: ['electronics', 'stationery', 'lamp'], onN: [2, 3], chairs: [1, 1] },
      { role: 'storage', where: 'wall', n: [2, 3], on: ['stationery', 'stationery', 'craft', 'tool'], onN: [1, 3] },
      { role: 'lamp', where: 'corner', n: [1, 1] },
      { role: 'plant', where: 'corner', n: [0, 1] },
      { role: 'instrument', where: 'wall', n: [0, 1] },
    ],
  },
  office: {
    floor: 'carpet', paintings: [0, 2],
    items: [
      { role: 'table', where: 'wall', n: [2, 4], on: ['electronics', 'stationery', 'electronics'], onN: [1, 3], chairs: [1, 1] },
      { role: 'storage', where: 'wall', n: [1, 2], on: ['stationery', 'container'], onN: [1, 2] },
      { role: 'plant', where: 'corner', n: [1, 2] },
      { role: 'appliance', where: 'wall', n: [0, 1] },
      { role: 'machine', where: 'wall', n: [0, 1] },
    ],
  },
  meeting: {
    floor: 'carpet', paintings: [1, 2],
    items: [
      { role: 'table', where: 'center', n: [1, 1], on: ['electronics', 'tableware', 'stationery'], onN: [2, 4], chairs: [4, 8] },
      { role: 'electronics', where: 'wall', n: [1, 1] },
      { role: 'plant', where: 'corner', n: [1, 2] },
      { role: 'storage', where: 'wall', n: [0, 1], on: ['tableware'], onN: [1, 2] },
    ],
  },
  storage: {
    floor: 'tile', paintings: [0, 0],
    items: [
      { role: 'storage', where: 'wall', n: [3, 6], on: ['container', 'tool', 'sports', 'container'], onN: [1, 3] },
      { role: 'container', where: 'free', n: [3, 7] },
      { role: 'machine', where: 'wall', n: [0, 1] },
      { role: 'craft', where: 'free', n: [0, 1] },
    ],
  },
  shop: {
    floor: 'tile', paintings: [0, 1],
    items: [
      { role: 'storage', where: 'wall', n: [3, 6], on: ['toy', 'food', 'tableware', 'electronics', 'stationery', 'container'], onN: [2, 4] },
      { role: 'table', where: 'center', n: [1, 1], on: ['toy', 'food', 'tableware', 'electronics', 'craft'], onN: [3, 6] },
      { role: 'container', where: 'corner', n: [1, 3] },
      { role: 'plant', where: 'corner', n: [0, 1] },
      { role: 'appliance', where: 'wall', n: [0, 1] },
    ],
  },
  gallery: {
    floor: 'wood', paintings: [2, 5],
    items: [
      { role: 'pedestal', where: 'free', n: [3, 7] },
      { role: 'instrument', where: 'wall', n: [0, 1] },
      { role: 'gear', where: 'wall', n: [0, 2] },
      { role: 'machine', where: 'wall', n: [0, 1] },
      { role: 'bench', where: 'center', n: [0, 1] },
    ],
  },
  workshop: {
    floor: 'tile', paintings: [0, 1],
    items: [
      { role: 'machine', where: 'wall', n: [1, 3] },
      { role: 'table', where: 'wall', n: [1, 2], on: ['tool', 'tool', 'container'], onN: [2, 4] },
      { role: 'storage', where: 'wall', n: [1, 2], on: ['tool', 'container'], onN: [1, 3] },
      { role: 'container', where: 'free', n: [2, 4] },
      { role: 'craft', where: 'free', n: [0, 1] },
    ],
  },
  library: {
    floor: 'wood', rug: true, paintings: [1, 2],
    items: [
      { role: 'storage', where: 'wall', n: [3, 7], on: ['stationery', 'stationery', 'stationery', 'craft'], onN: [1, 3] },
      { role: 'table', where: 'center', n: [1, 1], on: ['stationery', 'lamp', 'stationery'], onN: [1, 3], chairs: [2, 4] },
      { role: 'lamp', where: 'corner', n: [1, 2] },
      { role: 'plant', where: 'corner', n: [0, 1] },
    ],
  },
};

const PEDESTAL_ROLES = ['craft', 'gear', 'toy', 'instrument', 'vehicle', 'building', 'machine', 'electronics', 'food', 'tableware', 'sports'];
const NOT_PORTAL = new Set(['chair', 'table', 'pedestal']);
const WALL_COLS = ['#efe6d8', '#dfe8e3', '#e9dcd0', '#d9e2ec', '#f2ead3', '#e6d6de', '#d6d0c4'];

export class InteriorLevel implements Level {
  name: string;
  group = new THREE.Group();
  spawn = { pos: new THREE.Vector3(), yaw: 0 };
  env: Env;
  private cols: Rect[] = [];
  private ports: Portal[] = [];
  private rng: Rng;
  private lights: THREE.PointLight[] = [];

  constructor(private desc: Extract<LevelDesc, { kind: 'interior' }>) {
    this.rng = new Rng(hashN(desc.seed, desc.floor));
    this.name = desc.floor > 0 ? `${desc.name} · floor ${desc.floor + 1}` : desc.name;
    const b = BIOMES[desc.biome] ?? BIOMES.town;
    this.env = {
      skyTop: '#1a1612', skyBottom: '#2a241e', stars: false, fog: null, fogNear: 0, fogFar: 0, sun: null,
      hemi: { sky: '#fff1dc', ground: '#5a4a3a', intensity: b.night ? 0.4 : 0.55 }, ambient: 0.06, envIntensity: 0.3, exposure: 0.95,
    };
    this.generate();
  }

  colliders() {
    return this.cols;
  }
  portals() {
    return this.ports;
  }
  update(_dt: number, _p: THREE.Vector3, time: number) {
    // a subtle flicker in a few lights makes rooms feel alive
    this.lights.forEach((l, i) => {
      if (i % 5 === 3) l.intensity = l.userData.base * (0.92 + 0.08 * Math.sin(time * 13 + i) * Math.sin(time * 7.1));
    });
  }
  dispose() {
    disposeTree(this.group);
  }

  // ------------------------------------------------------------------ layout

  private generate() {
    const r = this.rng;
    const style = this.desc.style;
    const big = style === 'museum' || style === 'office' || style === 'shop';
    const W = r.range(big ? 18 : 13, big ? 28 : 22);
    const D = r.range(big ? 14 : 11, big ? 24 : 18);
    const bounds = { x0: -W / 2, z0: -D / 2, x1: W / 2, z1: D / 2 };

    // BSP into rooms
    const leaves: Room[] = [];
    const splits: Split[] = [];
    const minRoom = style === 'museum' ? 6 : 3.6;
    const divide = (x0: number, z0: number, x1: number, z1: number, depth: number) => {
      const w = x1 - x0, d = z1 - z0;
      const area = w * d;
      const stop = (area < 30 && depth > 0) || depth > 4 || (depth >= 2 && r.chance(0.25)) || (w < minRoom * 2 && d < minRoom * 2);
      if (stop) {
        leaves.push({ x0, z0, x1, z1, type: '' });
        return;
      }
      const vertical = w > d * 1.2 ? true : d > w * 1.2 ? false : r.chance(0.5);
      if (vertical && w >= minRoom * 2) {
        const c = x0 + w * r.range(0.35, 0.65);
        splits.push({ axis: 'x', c, a0: z0, a1: z1, door: 0 });
        divide(x0, z0, c, z1, depth + 1);
        divide(c, z0, x1, z1, depth + 1);
      } else if (!vertical && d >= minRoom * 2) {
        const c = z0 + d * r.range(0.35, 0.65);
        splits.push({ axis: 'z', c, a0: x0, a1: x1, door: 0 });
        divide(x0, z0, x1, c, depth + 1);
        divide(x0, c, x1, z1, depth + 1);
      } else {
        leaves.push({ x0, z0, x1, z1, type: '' });
      }
    };
    divide(bounds.x0, bounds.z0, bounds.x1, bounds.z1, 0);

    // one door per split, away from T-junctions
    for (const s of splits) {
      const blockers = splits.filter((o) => o.axis !== s.axis && (Math.abs(o.a0 - s.c) < 0.01 || Math.abs(o.a1 - s.c) < 0.01)).map((o) => o.c);
      let best = (s.a0 + s.a1) / 2;
      for (let k = 0; k < 30; k++) {
        const t = r.range(s.a0 + 1, s.a1 - 1);
        if (blockers.every((b) => Math.abs(b - t) > DOOR)) {
          best = t;
          break;
        }
      }
      s.door = best;
    }

    // exit door on the +z wall
    const zBlock = splits.filter((o) => o.axis === 'x' && Math.abs(o.a1 - bounds.z1) < 0.01).map((o) => o.c);
    let exitX = 0;
    for (let k = 0; k < 40; k++) {
      const t = r.range(bounds.x0 + 1.5, bounds.x1 - 1.5);
      if (zBlock.every((b) => Math.abs(b - t) > DOOR + 0.3)) {
        exitX = t;
        break;
      }
    }
    this.spawn.pos.set(exitX, 0, bounds.z1 - 1.3);
    this.spawn.yaw = 0;

    // materials
    const wallCol = r.pick(WALL_COLS);
    const wallMat = mat('#ffffff', { map: wallpaperTex(wallCol, r.int(0, 7)), rough: 0.9 });

    const trim = mat('#f4f1ea', { rough: 0.6 });
    const g = this.group;

    // ceiling
    const ceil = plane(mat('#f3f0ea', { rough: 1 }), W + 1, D + 1, 0, H, 0);
    ceil.rotation.x = Math.PI / 2;
    g.add(ceil);

    // walls
    const wallSeg = (axis: 'x' | 'z', c: number, a0: number, a1: number, gaps: number[]) => {
      const pts = [a0, ...gaps.flatMap((d) => [d - DOOR / 2, d + DOOR / 2]), a1];
      for (let i = 0; i < pts.length; i += 2) {
        const s0 = pts[i], s1 = pts[i + 1];
        if (s1 - s0 < 0.02) continue;
        const len = s1 - s0, mid = (s0 + s1) / 2;
        const wm = axis === 'x' ? box(wallMat, T, H, len, c, 0, mid, false) : box(wallMat, len, H, T, mid, 0, c, false);
        setWallUV(wm, len);
        g.add(wm);
        g.add(axis === 'x' ? box(trim, T + 0.04, 0.12, len, c, 0, mid, false) : box(trim, len, 0.12, T + 0.04, mid, 0, c, false));
        this.cols.push(axis === 'x' ? rect(c, mid, T + 0.1, len) : rect(mid, c, len, T + 0.1));
      }
      for (const d of gaps) {
        // lintel + frame
        g.add(axis === 'x' ? box(wallMat, T, H - 2.3, DOOR, c, 2.3, d, false) : box(wallMat, DOOR, H - 2.3, T, d, 2.3, c, false));
        g.add(axis === 'x' ? box(trim, T + 0.06, 0.1, DOOR + 0.1, c, 2.25, d, false) : box(trim, DOOR + 0.1, 0.1, T + 0.06, d, 2.25, c, false));
      }
    };
    for (const s of splits) wallSeg(s.axis, s.c, s.a0, s.a1, [s.door]);
    wallSeg('z', bounds.z0, bounds.x0, bounds.x1, []);
    wallSeg('z', bounds.z1, bounds.x0, bounds.x1, [exitX]);
    wallSeg('x', bounds.x0, bounds.z0, bounds.z1, []);
    wallSeg('x', bounds.x1, bounds.z0, bounds.z1, []);

    // exit door
    const exitG = new THREE.Group();
    exitG.add(box(mat('#4a3426', { rough: 0.5 }), DOOR - 0.1, 2.25, 0.06, 0, 0, 0.12, false));
    const signText = this.desc.floor > 0 ? 'DOWNSTAIRS' : 'EXIT';
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.24), new THREE.MeshBasicMaterial({ map: signTex(signText, '#0c5a2a', '#e8ffe8') }));
    sign.userData.owned = true;
    sign.position.set(0, 2.55, -0.1);
    sign.rotation.y = Math.PI;
    exitG.add(sign);
    exitG.add(glow('#5aff8a', 0.9, 0, 2.55, -0.2, 0.5));
    exitG.position.set(exitX, 0, bounds.z1);
    g.add(exitG);
    this.ports.push({
      box: new THREE.Box3(new THREE.Vector3(exitX - 0.8, 0, bounds.z1 - 0.6), new THREE.Vector3(exitX + 0.8, 2.4, bounds.z1 + 0.3)),
      label: this.desc.floor > 0 ? 'Go back downstairs' : 'Leave the building',
      target: 'back',
    });

    // windows on exterior walls: glowing panes of the outside world
    const outside = BIOMES[this.desc.biome] ?? BIOMES.town;
    const paneMat = mat(outside.skyBottom, { emissive: outside.night ? '#16224a' : outside.skyBottom, ei: outside.night ? 0.6 : 0.85, rough: 0.2 });
    const frameMat = mat('#e9e4da', { rough: 0.6 });
    const addWindows = (axis: 'x' | 'z', c: number, a0: number, a1: number, inward: number, avoid: number[]) => {
      for (let t = a0 + 2; t < a1 - 1.5; t += r.range(2.6, 3.6)) {
        if (avoid.some((a) => Math.abs(a - t) < 1.6)) continue;
        const off = c + inward * (T / 2 + 0.005);
        if (axis === 'z') {
          g.add(box(frameMat, 1.4, 1.5, 0.04, t, 0.95, off, false));
          g.add(box(paneMat, 1.25, 1.35, 0.05, t, 1.02, off, false));
        } else {
          g.add(box(frameMat, 0.04, 1.5, 1.4, off, 0.95, t, false));
          g.add(box(paneMat, 0.05, 1.35, 1.25, off, 1.02, t, false));
        }
      }
    };
    const xsplits = splits.filter((s) => s.axis === 'x').map((s) => s.c);
    const zsplits = splits.filter((s) => s.axis === 'z').map((s) => s.c);
    addWindows('z', bounds.z0, bounds.x0, bounds.x1, 1, xsplits);
    addWindows('z', bounds.z1, bounds.x0, bounds.x1, -1, [...xsplits, exitX]);
    addWindows('x', bounds.x0, bounds.z0, bounds.z1, 1, zsplits);
    addWindows('x', bounds.x1, bounds.z0, bounds.z1, -1, zsplits);

    // room types: largest rooms first
    const types = STYLE_ROOMS[style] ?? STYLE_ROOMS.house;
    const sorted = [...leaves].sort((a, b) => (b.x1 - b.x0) * (b.z1 - b.z0) - (a.x1 - a.x0) * (a.z1 - a.z0));
    sorted.forEach((room, i) => (room.type = types[i % types.length]));

    // which room gets the stairs up
    const canGoUp = this.desc.floor < this.desc.floors - 1;
    const stairRoom = canGoUp ? sorted.find((rm) => !(exitX > rm.x0 && exitX < rm.x1 && rm.z1 === bounds.z1)) ?? sorted[0] : null;

    // door clearance zones
    const doorZones: Rect[] = splits.map((s) => (s.axis === 'x' ? rect(s.c, s.door, 2.2, DOOR + 0.5) : rect(s.door, s.c, DOOR + 0.5, 2.2)));
    doorZones.push(rect(exitX, bounds.z1 - 1, DOOR + 0.8, 2.4));

    sorted.forEach((room, i) => {
      this.furnish(room, doorZones, i < 12, room === stairRoom, splits, exitX, bounds);
    });
  }

  // ------------------------------------------------------------------ rooms

  private furnish(room: Room, doorZones: Rect[], light: boolean, stairs: boolean, splits: Split[], exitX: number, bounds: { x0: number; z0: number; x1: number; z1: number }) {
    const r = this.rng.fork(hashN(room.x0 * 100, room.z0 * 100));
    const spec = ROOMS[room.type] ?? ROOMS.living;
    const g = this.group;
    const ix0 = room.x0 + T / 2 + 0.03, iz0 = room.z0 + T / 2 + 0.03;
    const ix1 = room.x1 - T / 2 - 0.03, iz1 = room.z1 - T / 2 - 0.03;
    const w = ix1 - ix0, d = iz1 - iz0;
    const cx = (ix0 + ix1) / 2, cz = (iz0 + iz1) / 2;

    // floor
    let fm: THREE.Material;
    // floor UVs are in units of 2 m (see below): photo-scanned floors at their real tile size
    if (spec.floor === 'wood') fm = surface(r.pick(['floor_parquet', 'floor_laminate']), [2, 2], { roughness: 0.8 });
    else if (spec.floor === 'tile') fm = surface(r.pick(['floor_tiles', 'floor_marble']), [2, 2], { roughness: 0.6 });
    else fm = surface('floor_carpet', [2, 2], { roughness: 1, color: r.pick(['#c8d0e0', '#e0c8c8', '#c8e0d0', '#e0d8c0']) });
    void woodFloorTex; void tileFloorTex; void carpetTex;
    const floor = plane(fm, room.x1 - room.x0, room.z1 - room.z0, (room.x0 + room.x1) / 2, 0, (room.z0 + room.z1) / 2);
    // world-scaled floor uvs
    floor.geometry = new THREE.PlaneGeometry(room.x1 - room.x0, room.z1 - room.z0);
    floor.scale.set(1, 1, 1);
    const uv = floor.geometry.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * (room.x1 - room.x0)) / 2, (uv.getY(i) * (room.z1 - room.z0)) / 2);
    floor.userData.owned = true;
    g.add(floor);

    // ceiling lamp
    if (light) {
      const pl = new THREE.PointLight('#ffe2b8', 0, Math.hypot(w, d) * 1.4 + 4, 1.6);
      const inten = 2.2 + w * d * 0.11;
      pl.intensity = inten;
      pl.userData.base = inten;
      pl.position.set(cx, H - 0.5, cz);
      g.add(pl);
      this.lights.push(pl);
    }
    g.add(cyl(mat('#fff6e0', { emissive: '#fff1d0', ei: 1.2 }), 0.35, 0.06, cx, H - 0.07, cz));
    g.add(glow('#ffe7c0', 1.4, cx, H - 0.2, cz, 0.35));

    const occ: Rect[] = doorZones.filter((z) => overlaps(z, { minX: ix0, minZ: iz0, maxX: ix1, maxZ: iz1 }));
    const inside = (fp: Rect) => fp.minX >= ix0 && fp.maxX <= ix1 && fp.minZ >= iz0 && fp.maxZ <= iz1;
    const free = (fp: Rect) => inside(fp) && occ.every((o) => !overlaps(o, fp, 0.08));

    // stairs up
    if (stairs) {
      const sw = 1.3, sl = 3.8;
      for (let k = 0; k < 40; k++) {
        const alongX = w > d ? true : r.chance(0.3);
        const len = alongX ? sl : sw;
        const dep = alongX ? sw : sl;
        const px = r.range(ix0 + len / 2, ix1 - len / 2);
        const pz = r.chance(0.5) ? iz0 + dep / 2 : iz1 - dep / 2;
        const fp = rect(px, pz, len, dep);
        if (!free(fp) || len > w || dep > d) continue;
        occ.push(rect(px, pz, len + (alongX ? 2 : 0.4), dep + (alongX ? 0.4 : 2)));
        this.stairs(px, pz, alongX, sl, sw);
        break;
      }
    }

    // rug
    if (spec.rug && w > 3 && d > 3) {
      const rug = plane(mat('#ffffff', { map: rugTex(r.int(0, 30)), rough: 1 }), Math.min(w * 0.55, 3.2), Math.min(d * 0.55, 2.4), cx, 0.012, cz);
      g.add(rug);
    }

    const place = (e: ModelEntry, scale: number, where: Spec['where']): { x: number; z: number; rot: number; fp: Rect; size: THREE.Vector3 } | null => {
      const sx = e.size[0] * scale, sy = e.size[1] * scale, sz = e.size[2] * scale;
      const size = new THREE.Vector3(sx, sy, sz);
      for (let k = 0; k < 40; k++) {
        let x = 0, z = 0, rot = 0;
        if (where === 'center') {
          x = cx + r.range(-0.3, 0.3);
          z = cz + r.range(-0.3, 0.3);
          rot = r.int(0, 1) * (Math.PI / 2);
          if (sx > sz !== w > d) rot = Math.PI / 2;
          else rot = 0;
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
        if (!free(fp)) continue;
        return { x, z, rot, fp, size };
      }
      return null;
    };

    for (const it of spec.items) {
      const n = r.int(it.n[0], it.n[1]);
      for (let i = 0; i < n; i++) {
        if (it.role === 'pedestal') {
          this.pedestal(r, place, occ);
          continue;
        }
        const e = pickModel(it.role, r);
        if (!e) continue;
        const scale = normScale(e, it.role) * r.range(0.95, 1.05);
        const p = place(e, scale, it.where);
        if (!p) continue;
        occ.push(p.fp);
        const sp = this.put(e, scale, p.x, 0, p.z, p.rot, it.role);
        if (it.on) this.surface(r, sp.obj.position, p.fp, p.size.y, it.on, it.onN ?? [1, 2]);
        if (it.chairs) this.chairs(r, p.fp, r.int(it.chairs[0], it.chairs[1]), occ, free);
        if (it.role === 'lamp') g.add(glow('#ffd9a0', 0.9, p.x, p.size.y * 0.9, p.z, 0.6));
      }
    }

    // paintings
    const np = r.int(spec.paintings[0], spec.paintings[1]);
    for (let i = 0; i < np; i++) this.painting(r, room, splits, exitX, bounds);
  }

  private put(e: ModelEntry, scale: number, x: number, y: number, z: number, rot: number, role: string) {
    const sp = spawn(e, scale);
    sp.obj.position.set(x, y, z);
    sp.obj.rotation.y = rot;
    this.group.add(sp.obj);
    const fp = footprint(sp.size.x, sp.size.z, rot, x, z);
    if (y < 0.05) {
      this.cols.push(shrink(fp, 0.06));
      this.group.add(blob(fp.maxX - fp.minX, fp.maxZ - fp.minZ, x, z));
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

  private surface(r: Rng, at: THREE.Vector3, fp: Rect, top: number, roles: string[], n: [number, number]) {
    const count = r.int(n[0], n[1]);
    const used: Rect[] = [];
    for (let i = 0; i < count; i++) {
      const role = r.pick(roles);
      const e = pickModel(role, r);
      if (!e) continue;
      let scale = normScale(e, role);
      const fw = fp.maxX - fp.minX, fd = fp.maxZ - fp.minZ;
      // keep things smaller than the surface they sit on
      const maxFoot = Math.min(fw, fd) * 0.9;
      const foot = Math.max(e.size[0], e.size[2]) * scale;
      if (foot > maxFoot) scale *= maxFoot / foot;
      if (e.size[1] * scale > 0.8) scale *= 0.8 / (e.size[1] * scale);
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
        this.put(e, scale, x, at.y + top, z, rot, role);
        break;
      }
    }
  }

  private chairs(r: Rng, table: Rect, n: number, occ: Rect[], free: (fp: Rect) => boolean) {
    const e = pickModel('chair', r);
    if (!e) return;
    const scale = normScale(e);
    const s = Math.max(e.size[0], e.size[2]) * scale;
    const tcx = (table.minX + table.maxX) / 2, tcz = (table.minZ + table.maxZ) / 2;
    const spots: [number, number][] = [];
    const tw = table.maxX - table.minX, td = table.maxZ - table.minZ;
    const perX = Math.max(1, Math.floor(tw / (s + 0.15)));
    const perZ = Math.max(1, Math.floor(td / (s + 0.15)));
    for (let i = 0; i < perX; i++) {
      const x = table.minX + ((i + 0.5) * tw) / perX;
      spots.push([x, table.minZ - s / 2 + 0.1], [x, table.maxZ + s / 2 - 0.1]);
    }
    for (let i = 0; i < perZ; i++) {
      const z = table.minZ + ((i + 0.5) * td) / perZ;
      spots.push([table.minX - s / 2 + 0.1, z], [table.maxX + s / 2 - 0.1, z]);
    }
    r.shuffle(spots);
    let placed = 0;
    for (const [x, z] of spots) {
      if (placed >= n) break;
      const fp = rect(x, z, s * 0.8, s * 0.8);
      if (!free(fp)) continue;
      occ.push(fp);
      const rot = Math.atan2(tcx - x, tcz - z);
      const sp = spawn(e, scale);
      sp.obj.position.set(x, 0, z);
      sp.obj.rotation.y = rot;
      this.group.add(sp.obj);
      this.group.add(blob(s * 0.8, s * 0.8, x, z));
      this.cols.push(rect(x, z, s * 0.5, s * 0.5));
      placed++;
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
    this.group.add(box(stone, pw, ph, pw, p.x, 0, p.z));
    this.group.add(box(stone, pw + 0.12, 0.06, pw + 0.12, p.x, ph, p.z));
    this.cols.push(rect(p.x, p.z, pw, pw));
    this.group.add(blob(pw, pw, p.x, p.z));
    const scale = scaleTo(e, pw * r.range(0.7, 0.95), 'max');
    const rot = r.range(0, Math.PI * 2);
    const sp = spawn(e, scale);
    sp.obj.position.set(p.x, ph + 0.06, p.z);
    sp.obj.rotation.y = rot;
    this.group.add(sp.obj);
    this.group.add(glow('#fff2d6', 1.6, p.x, ph + 0.06 + sp.size.y + 0.3, p.z, 0.35));
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

  private painting(r: Rng, room: Room, splits: Split[], exitX: number, bounds: { x0: number; z0: number; x1: number; z1: number }) {
    // choose a wall of this room and a spot away from doors
    for (let k = 0; k < 20; k++) {
      const side = r.int(0, 3);
      const alongX = side < 2;
      const a0 = alongX ? room.x0 : room.z0;
      const a1 = alongX ? room.x1 : room.z1;
      if (a1 - a0 < 2.5) continue;
      const t = r.range(a0 + 1.1, a1 - 1.1);
      const c = side === 0 ? room.z0 : side === 1 ? room.z1 : side === 2 ? room.x0 : room.x1;
      const doors = splits.filter((s) => (alongX ? s.axis === 'z' : s.axis === 'x') && Math.abs(s.c - c) < 0.01).map((s) => s.door);
      if (alongX && Math.abs(c - bounds.z1) < 0.01) doors.push(exitX);
      if (doors.some((d) => Math.abs(d - t) < 1.6)) continue;
      const inward = side === 0 || side === 2 ? 1 : -1;
      const off = c + inward * (T / 2 + 0.03);
      const seed = r.int(0, 1e6);
      const pw = r.range(0.9, 1.6), ph = pw * 0.75;
      const frame = mat(r.pick(['#3a2a1a', '#c9a227', '#1a1a1a', '#e8e2d6']), { rough: 0.5, metal: 0.2 });
      const art = new THREE.MeshStandardMaterial({ map: paintingTex(seed), roughness: 0.7 });
      const grp = new THREE.Group();
      grp.add(box(frame, pw + 0.12, ph + 0.12, 0.05, 0, -(ph + 0.12) / 2, 0, false));
      const pic = new THREE.Mesh(new THREE.PlaneGeometry(pw, ph), art);
      pic.userData.owned = true;
      pic.position.z = 0.03;
      grp.add(pic);
      grp.position.set(alongX ? t : off, 1.65, alongX ? off : t);
      grp.rotation.y = side === 0 ? 0 : side === 1 ? Math.PI : side === 2 ? Math.PI / 2 : -Math.PI / 2;
      this.group.add(grp);
      const name = paintingName(new Rng(seed));
      const bx = new THREE.Box3().setFromObject(grp).expandByScalar(0.08);
      this.ports.push({
        box: bx,
        label: `Step into the painting “${name}”`,
        sub: 'oil on canvas, artist unknown',
        target: { kind: 'city', seed: hashN(seed, 4242), biome: r.pick(ROLE_BIOMES.painting), name: `Inside “${name}”` },
        shrink: pw,
      });
      return;
    }
  }

  private stairs(x: number, z: number, alongX: boolean, len: number, wid: number) {
    const g = new THREE.Group();
    const wood = mat('#7a5236', { rough: 0.6 });
    const steps = 14;
    for (let i = 0; i < steps; i++) {
      const h = ((i + 1) / steps) * H;
      const t = -len / 2 + (i + 0.5) * (len / steps);
      g.add(alongX ? box(wood, len / steps, h, wid, t, 0, 0) : box(wood, wid, h, len / steps, 0, 0, t));
    }
    // railing
    const rail = mat('#2b2b2b', { metal: 0.7, rough: 0.4 });
    const rr = alongX ? box(rail, len, 0.05, 0.05, 0, 0, wid / 2) : box(rail, 0.05, 0.05, len, wid / 2, 0, 0);
    rr.position.y = H / 2 + 0.9;
    rr.rotation[alongX ? 'z' : 'x'] = alongX ? Math.atan2(H, len) : -Math.atan2(H, len);
    g.add(rr);
    g.position.set(x, 0, z);
    this.group.add(g);
    this.cols.push(alongX ? rect(x, z, len, wid) : rect(x, z, wid, len));
    const next = this.desc.floor + 1;
    this.ports.push({
      box: new THREE.Box3(new THREE.Vector3(x - (alongX ? len : wid) / 2 - 0.3, 0, z - (alongX ? wid : len) / 2 - 0.3), new THREE.Vector3(x + (alongX ? len : wid) / 2 + 0.3, H, z + (alongX ? wid : len) / 2 + 0.3)),
      label: `Go upstairs to floor ${next + 1}`,
      sub: `${this.desc.floors} floors in this building`,
      target: { ...this.desc, floor: next },
    });
  }
}

function shrink(r: Rect, m: number): Rect {
  return { minX: r.minX + m, minZ: r.minZ + m, maxX: r.maxX - m, maxZ: r.maxZ - m };
}

function setWallUV(m: THREE.Mesh, len: number) {
  // walls share a unit box; give long walls their own geometry so wallpaper is not stretched
  const g = new THREE.BoxGeometry(1, 1, 1);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (len / 1.5), uv.getY(i) * (H / 1.5));
  m.geometry = g;
  m.userData.owned = true;
}
