import * as THREE from 'three';
import type { Env, Level, LevelDesc, Portal, Rect } from './level';
import { disposeTree, finishBuilding } from './level';
import type { ModelEntry } from './assets';
import { spawn } from './assets';
import { Rng, hashN } from './rng';
import { mat } from './build';
import { Kit } from './rooms/kit';
import { cabinetContents } from './rooms/contents';
import { signTex } from './textures';

/**
 * Shrinking into an object (E on a small thing) builds a world *from that object*, at the scale the
 * shrink implies, instead of a generic miniature city:
 *
 *   garden  (plants)      you stand on the pot's soil among the plant's own stems and leaves scaled up,
 *                         soil grains, perlite, pebbles, moss, a few ants
 *   vessel  (containers, tableware, storage)  inside it: its walls rise around you in its own colour,
 *                         its contents at the new scale (storage: the lazy cabinet contents, scaled)
 *   circuit (electronics, appliances, machines, lamps)  its board: copper traces as streets,
 *                         chips as buildings, capacitors as towers, glowing LEDs
 *   food                  a macro surface: crumb, seeds, sugar crystals, droplets
 *   surface (anything else) a landscape of its own surface: its scaled model as the mountain on
 *                         the horizon, ground in its colour and material
 *   city    (buildings, model towns: city-like things) the existing CityLevel
 *
 * Everything is placed at real size times the shrink factor k (a 3 mm ant becomes k·3 mm). The
 * level is built in slices (seamless.ts staging) and is cheap: a few merged meshes and instanced grains.
 */

export type MacroMode = 'garden' | 'vessel' | 'circuit' | 'food' | 'surface';
export type MacroDesc = Extract<LevelDesc, { kind: 'macro' }>;

/** which world an object of this role holds (null: a city — buildings and model towns only) */
export function macroMode(e: Pick<ModelEntry, 'role' | 'family'>): MacroMode | null {
  const r = e.role;
  if (r === 'building') return null;
  if (r === 'plant') return 'garden';
  if (r === 'food') return 'food';
  if (r === 'electronics' || r === 'appliance' || r === 'machine' || r === 'lamp') return 'circuit';
  if (r === 'container' || r === 'storage' || r === 'tableware') return 'vessel';
  return 'surface';
}

/** world metres the object's largest dimension becomes, per mode */
const SPAN: Record<MacroMode, number> = { garden: 40, vessel: 36, circuit: 120, food: 60, surface: 160 };

const WHAT: Record<MacroMode, string> = {
  garden: 'a forest of its own stems and leaves, on the soil',
  vessel: 'its inside, at your new size',
  circuit: 'its circuit board: copper streets, chip buildings',
  food: 'a macro landscape of crumb and crystals',
  surface: 'a landscape of its own surface',
};

/** a short noun for the prompt ("the fern") */
function noun(title: string) {
  const t = title.replace(/[_-]+/g, ' ').replace(/\s+\d+$/, '').trim();
  return t.length > 28 ? t.slice(0, 26) + '…' : t;
}

/**
 * The portal fields for shrinking into a model: a contextual world for most things, the city for
 * buildings. `size` is the object's largest dimension as placed (m).
 */
export function shrinkInto(e: ModelEntry, size: number, seed: number, cityBiome: string): Pick<Portal, 'label' | 'sub' | 'target' | 'shrink'> {
  const mode = macroMode(e);
  const n = noun(e.title);
  if (!mode) {
    return { label: `Shrink into ${n}`, sub: `${e.role} · a town at its scale`, target: { kind: 'city', seed, biome: cityBiome, name: `Inside “${e.title}”`, source: e, sourceScale: size }, shrink: size };
  }
  const k = SPAN[mode] / Math.max(0.02, size);
  return {
    label: `Shrink into ${n}`,
    sub: WHAT[mode],
    target: { kind: 'macro', seed, name: `In “${n}”`, mode, title: e.title, source: e, sourceScale: size },
    // the depth counter: main.ts multiplies the scale by shrink / 1000 (1/k)
    shrink: 1000 / k,
  };
}

/** the object's own colour: the first '#rrggbb' in its material names */
function ownColour(e: ModelEntry | undefined, fallback: string) {
  const names = (e as unknown as { matNames?: string[] } | undefined)?.matNames ?? [];
  for (const n of names) {
    const m = /#([0-9a-f]{6})/i.exec(n);
    if (m) return '#' + m[1];
  }
  return fallback;
}

// ---------------------------------------------------------------- shared bits

const unitIco = new THREE.IcosahedronGeometry(1, 0);
const unitSphere = new THREE.SphereGeometry(1, 8, 6);
const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 10);
const unitBox = new THREE.BoxGeometry(1, 1, 1);

/** n instances of a unit geometry; place(i) -> [x, y, z, sx, sy, sz, rotY] */
function scatter(into: THREE.Object3D, geo: THREE.BufferGeometry, m: THREE.Material, n: number, place: (i: number) => number[] | null, colors?: (i: number) => THREE.Color) {
  const im = new THREE.InstancedMesh(geo, m, n);
  const o = new THREE.Object3D();
  let k = 0;
  for (let i = 0; i < n; i++) {
    const p = place(i);
    if (!p) continue;
    o.position.set(p[0], p[1], p[2]);
    o.scale.set(p[3], p[4], p[5]);
    o.rotation.set(p[7] ?? 0, p[6] ?? 0, p[8] ?? 0);
    o.updateMatrix();
    im.setMatrixAt(k, o.matrix);
    if (colors) im.setColorAt(k, colors(i));
    k++;
  }
  im.count = k;
  im.castShadow = true;
  im.receiveShadow = true;
  im.computeBoundingSphere();
  into.add(im);
  return im;
}

/** a ring of wall colliders (radius R) */
function ring(cols: Rect[], R: number, n = 24, t = 1.5) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, x = Math.cos(a) * (R + t / 2), z = Math.sin(a) * (R + t / 2);
    const s = (2 * Math.PI * R) / n + t;
    cols.push({ minX: x - s / 2, maxX: x + s / 2, minZ: z - s / 2, maxZ: z + s / 2 });
  }
}

// ---------------------------------------------------------------- the level

export class MacroLevel implements Level {
  name: string;
  group = new THREE.Group();
  spawn = { pos: new THREE.Vector3(0, 0, 0), yaw: 0 };
  env: Env;
  staging?: Iterator<unknown>;
  readonly mode: MacroMode;
  /** world metres per real metre */
  readonly k: number;
  /** the walkable disc (spawn and everything walkable lies inside it) */
  readonly radius: number;
  private cols: Rect[] = [];
  private ports: Portal[] = [];
  private ants: { o: THREE.Object3D; a: number; r: number; v: number }[] = [];
  private r: Rng;

  constructor(public desc: MacroDesc, opts: { staged?: boolean } = {}) {
    this.mode = (desc.mode as MacroMode) in SPAN ? (desc.mode as MacroMode) : 'surface';
    this.k = SPAN[this.mode] / Math.max(0.02, desc.sourceScale);
    this.radius = this.mode === 'circuit' ? 70 : this.mode === 'surface' ? 90 : this.mode === 'food' ? 60 : this.mode === 'vessel' ? 17 : 26;
    this.name = desc.name;
    this.r = new Rng(hashN(desc.seed, 3301));
    const dark = this.mode === 'vessel' || this.mode === 'circuit';
    // a room far above / around: warm, dim, a lamp for a sun
    this.env = {
      skyTop: dark ? '#141210' : '#5a5348', skyBottom: dark ? '#2a2620' : '#b8ab94', stars: false,
      fog: this.mode === 'circuit' ? '#0e1a14' : dark ? '#1c1814' : '#a89c88', fogNear: this.radius * 0.6, fogFar: this.radius * 3,
      sun: { color: this.mode === 'circuit' ? '#dfe8ff' : '#ffe2b8', intensity: this.mode === 'vessel' ? 1.6 : 2.6, elev: this.mode === 'vessel' ? 78 : 48, azim: 140 },
      hemi: { sky: '#f4e8d6', ground: '#4a3a2a', intensity: this.mode === 'circuit' ? 0.5 : 0.7 }, ambient: 0.08, envIntensity: 0.4, exposure: 1.0,
    };
    this.group.name = `macro:${this.mode}`;
    this.spawn.pos.set(0, 0, this.radius * 0.55);
    this.spawn.yaw = 0;
    this.staging = this.generate();
    if (!opts.staged) finishBuilding(this);
  }

  colliders() {
    return this.cols;
  }
  portals() {
    return this.ports;
  }
  update(dt: number) {
    for (const a of this.ants) {
      a.a += (a.v * dt) / a.r;
      a.o.position.set(Math.cos(a.a) * a.r, 0, Math.sin(a.a) * a.r);
      a.o.rotation.y = -a.a + (a.v > 0 ? Math.PI : 0);
    }
  }
  dispose() {
    disposeTree(this.group);
  }

  private *generate() {
    switch (this.mode) {
      case 'garden': yield* this.garden(); break;
      case 'vessel': yield* this.vessel(); break;
      case 'circuit': yield* this.circuit(); break;
      case 'food': yield* this.food(); break;
      default: yield* this.surface(); break;
    }
    ring(this.cols, this.radius);
    // keep the spawn clear
    const s = this.spawn.pos;
    this.cols = this.cols.filter((c) => !(s.x > c.minX - 0.6 && s.x < c.maxX + 0.6 && s.z > c.minZ - 0.6 && s.z < c.maxZ + 0.6));
  }

  /** the source model at k, its base at y0, centred at (x, z) (loads async) */
  private model(y0: number, x = 0, z = 0) {
    const e = this.desc.source;
    if (!e) return null;
    const scale = (this.desc.sourceScale / Math.max(...e.size)) * this.k;
    const sp = spawn(e, scale);
    sp.obj.position.set(x, y0, z);
    this.group.add(sp.obj);
    return sp;
  }

  // ------------------------------------------------------------ plant: a garden on the soil

  private *garden() {
    const R = this.radius, r = this.r, k = this.k, g = this.group;
    const soil = mat('#3b2a1e', { rough: 1 });
    const kit = new Kit();
    kit.cyl(soil, R + 3, R + 3, 0.2, 0, -0.2, 0, 48);
    // the pot's rim around the soil, terracotta, rising past your head
    kit.cyl(mat('#b5643f', { rough: 0.85 }), R + 3.2, R + 2.6, 6 + r.range(0, 4), 0, -0.2, 0, 48, true);
    kit.finish(g);
    yield;
    // the plant itself, its stems as trunks: the model sits a third deep (in its pot) at the centre
    const H = this.desc.sourceScale * k;
    this.model(-H * 0.28);
    this.cols.push({ minX: -H * 0.05, maxX: H * 0.05, minZ: -H * 0.05, maxZ: H * 0.05 });
    yield;
    // soil grains (0.2-1 mm), perlite (white, 2-4 mm), pebbles (5-12 mm), moss cushions
    const inDisc = () => { const a = r.range(0, Math.PI * 2), d = Math.sqrt(r.next()) * R; return [Math.cos(a) * d, Math.sin(a) * d]; };
    scatter(g, unitIco, mat('#4a3423', { rough: 1 }), 2500, () => { const [x, z] = inDisc(); const s = r.range(0.0002, 0.001) * k; return [x, 0, z, s, s * 0.7, s, r.range(0, 6)]; }, () => new THREE.Color().setHSL(0.07, 0.35, r.range(0.08, 0.2)));
    scatter(g, unitIco, mat('#e8e4dc', { rough: 0.9 }), 160, () => { const [x, z] = inDisc(); const s = r.range(0.002, 0.004) * k; return [x, s * 0.3, z, s, s * 0.8, s, r.range(0, 6)]; });
    yield;
    const peb = mat('#8a8076', { rough: 0.7 });
    scatter(g, unitIco, peb, 26, (i) => {
      const [x, z] = inDisc();
      if (Math.hypot(x, z - R * 0.55) < 3) return null;
      const s = r.range(0.005, 0.012) * k;
      if (s > 0.5) this.cols.push({ minX: x - s * 0.8, maxX: x + s * 0.8, minZ: z - s * 0.8, maxZ: z + s * 0.8 });
      void i;
      return [x, s * 0.2, z, s, s * 0.6, s * r.range(0.8, 1.2), r.range(0, 6)];
    }, () => new THREE.Color().setHSL(0.08, 0.1, r.range(0.35, 0.6)));
    scatter(g, unitSphere, mat('#4f6b2a', { rough: 1 }), 60, () => { const [x, z] = inDisc(); const s = r.range(0.004, 0.012) * k; return [x, 0, z, s, s * 0.25, s, 0]; }, () => new THREE.Color().setHSL(r.range(0.2, 0.28), 0.5, r.range(0.2, 0.32)));
    yield;
    // ants (4 mm) walking circles round the stem
    const antK = new Kit();
    const L = 0.004 * k, black = mat('#140c08', { rough: 0.35, metal: 0.1 });
    antK.sphere(black, L * 0.16, 0, L * 0.14, -L * 0.32, 0.8);
    antK.sphere(black, L * 0.12, 0, L * 0.14, 0, 0.8);
    antK.sphere(black, L * 0.22, 0, L * 0.16, L * 0.36, 0.7);
    for (const zz of [-0.1, 0, 0.1]) for (const sx of [-1, 1]) antK.boxM(black, L * 0.32, L * 0.015, L * 0.015, sx * L * 0.14, L * 0.08, zz * L, new THREE.Euler(0, 0, sx * 0.5));
    const antG = new THREE.Group();
    antK.finish(antG);
    for (let i = 0; i < 5; i++) {
      const o = antG.clone();
      g.add(o);
      this.ants.push({ o, a: r.range(0, 6.28), r: r.range(H * 0.12, R * 0.85), v: r.range(0.008, 0.02) * k * (r.chance(0.5) ? 1 : -1) });
    }
  }

  // ------------------------------------------------------------ inside a container

  private *vessel() {
    const R = this.radius, r = this.r, k = this.k, g = this.group;
    const e = this.desc.source;
    const col = ownColour(e, r.pick(['#d8d2c4', '#8a6a4a', '#5a7a9a', '#c9c4bc']));
    const round = e ? Math.abs(e.size[0] - e.size[2]) / Math.max(e.size[0], e.size[2]) < 0.2 : true;
    const H = Math.max(8, (e ? e.size[1] / Math.max(...e.size) : 1) * this.desc.sourceScale * k);
    const wall = mat(col, { rough: 0.45, metal: 0.05 });
    const floorM = mat(new THREE.Color(col).multiplyScalar(0.8).getStyle(), { rough: 0.6 });
    const kit = new Kit();
    if (round) {
      kit.cyl(floorM, R + 1, R + 1, 0.3, 0, -0.3, 0, 48);
      kit.cyl(wall, R + 1.2, R + 1.2, H, 0, -0.3, 0, 48, true);
      kit.cyl(wall, R + 1.6, R + 1.6, 0.4, 0, H - 0.4, 0, 48, true);
    } else {
      const s = R * 2 + 2;
      kit.box(floorM, s, 0.3, s, 0, -0.3, 0);
      for (const [x, z, w, d] of [[0, -s / 2, s, 0.6], [0, s / 2, s, 0.6], [-s / 2, 0, 0.6, s], [s / 2, 0, 0.6, s]]) kit.box(wall, w, H, d, x, -0.3, z);
    }
    kit.finish(g);
    yield;
    // what is in it, at the new scale
    if (e?.role === 'storage') {
      // a cabinet's lazy contents (rooms/contents.ts), scaled by k: tins and boxes the size of houses
      const c = cabinetContents(this.desc.seed, 0.8, 0.9, 0.5);
      c.scale.setScalar(k * 0.9);
      c.position.set(0, 0, -R * 0.2);
      g.add(c);
      this.cols.push({ minX: -0.4 * k * 0.9, maxX: 0.4 * k * 0.9, minZ: -R * 0.2 - 0.5 * k * 0.9, maxZ: -R * 0.2 });
    } else {
      // coins (24 mm), buttons (15 mm), crumbs, a paper clip's worth of wire, dust
      const inDisc = (m = 0.9) => { const a = r.range(0, Math.PI * 2), d = Math.sqrt(r.next()) * R * m; return [Math.cos(a) * d, Math.sin(a) * d]; };
      scatter(g, unitCyl, mat('#b8925a', { rough: 0.3, metal: 0.9 }), 9, () => { const [x, z] = inDisc(); const s = 0.012 * k; this.cols.push({ minX: x - s * 0.7, maxX: x + s * 0.7, minZ: z - s * 0.7, maxZ: z + s * 0.7 }); return [x, 0.001 * k, z, s, 0.0018 * k, s, 0, r.range(-0.1, 0.1)]; });
      scatter(g, unitCyl, mat('#ffffff', { rough: 0.4 }), 12, () => { const [x, z] = inDisc(); const s = 0.0075 * k; return [x, 0.0012 * k, z, s, 0.0025 * k, s]; }, () => new THREE.Color(r.pick(['#e8e2d6', '#3a2a20', '#8a2a2a', '#2a3a5a', '#d8c070'])));
      scatter(g, unitIco, mat('#d8c8a8', { rough: 0.9 }), 400, () => { const [x, z] = inDisc(0.98); const s = r.range(0.0003, 0.0015) * k; return [x, 0, z, s, s * 0.6, s, r.range(0, 6)]; });
    }
    this.spawn.pos.set(0, 0, R * 0.6);
  }

  // ------------------------------------------------------------ a circuit board

  private *circuit() {
    const R = this.radius, r = this.r, k = this.k, g = this.group;
    const kit = new Kit();
    const pcb = mat('#1e5a3a', { rough: 0.45 });
    const copper = mat('#c8964a', { rough: 0.35, metal: 0.8 });
    const solder = mat('#c9ccce', { rough: 0.3, metal: 0.9 });
    kit.box(pcb, R * 2.4, 0.2, R * 2.4, 0, -0.2, 0);
    // copper traces on a street grid (0.3 mm traces, 2.54 mm pitch at this scale), vias at the crossings
    const pitch = Math.max(6, 0.00254 * k * 3);
    const tw = Math.max(0.4, 0.0003 * k);
    for (let x = -R; x <= R; x += pitch) if (r.chance(0.7)) kit.box(copper, tw, 0.04, R * 2, x, 0, 0);
    for (let z = -R; z <= R; z += pitch) if (r.chance(0.7)) kit.box(copper, R * 2, 0.04, tw, 0, 0, z);
    yield;
    // components on the blocks: chips (buildings), capacitors (towers), resistors, connectors
    const chip = mat('#141414', { rough: 0.5 });
    const leds: THREE.Vector3[] = [];
    for (let bx = -R + pitch / 2; bx < R; bx += pitch)
      for (let bz = -R + pitch / 2; bz < R; bz += pitch) {
        if (Math.hypot(bx, bz - R * 0.55) < pitch) continue; // the spawn block stays open
        if (Math.hypot(bx, bz) > R - 2) continue;
        const kind = r.next();
        const w = pitch * r.range(0.45, 0.8), d = pitch * r.range(0.4, 0.8);
        if (kind < 0.45) {
          const h = Math.max(0.6, 0.0012 * k * r.range(0.8, 1.6));
          kit.box(chip, w, h, d, bx, 0, bz);
          const n = Math.max(2, Math.floor(w / 1.2));
          for (let i = 0; i < n; i++) for (const s of [-1, 1]) kit.box(solder, 0.25, h * 0.3, 0.6, bx - w / 2 + (i + 0.5) * (w / n), 0, bz + s * (d / 2 + 0.3));
          this.cols.push({ minX: bx - w / 2, maxX: bx + w / 2, minZ: bz - d / 2 - 0.6, maxZ: bz + d / 2 + 0.6 });
        } else if (kind < 0.62) {
          const rr = Math.min(w, d) * 0.4, h = rr * r.range(1.5, 3.5);
          kit.cyl(mat(r.pick(['#1a2a5a', '#2a2a2a', '#5a1a1a']), { rough: 0.4 }), rr, rr, h, bx, 0, bz, 16);
          kit.cyl(solder, rr * 0.98, rr * 0.98, 0.1, bx, h, bz, 16);
          this.cols.push({ minX: bx - rr, maxX: bx + rr, minZ: bz - rr, maxZ: bz + rr });
        } else if (kind < 0.8) {
          const l = w * 0.8, rr = Math.min(d, 2) * 0.25;
          kit.rod(mat('#c9b48a', { rough: 0.6 }), rr, l * 0.6, bx, rr, bz, 'x', 10);
          for (const s of [-1, 1]) kit.box(solder, l * 0.22, 0.1, rr, bx + s * l * 0.4, 0, bz);
          for (let i = 0; i < 3; i++) kit.box(mat(r.pick(['#8a2a1a', '#d8a020', '#2a2a2a', '#5a3a8a'])), 0.12, rr * 2.04, rr * 2.04, bx - l * 0.15 + i * l * 0.12, 0, bz);
        } else if (kind < 0.88) {
          leds.push(new THREE.Vector3(bx, 0, bz));
        }
      }
    kit.finish(g);
    yield;
    // LEDs: lit domes on the board, and a chip label or two
    const ledM = mat('#ff4030', { emissive: '#ff3020', ei: 2.4 });
    scatter(g, unitSphere, ledM, leds.length, (i) => { const p = leds[i]; const s = Math.max(0.8, 0.0015 * k); return [p.x, 0, p.z, s, s * 0.9, s]; });
    for (let i = 0; i < 6; i++) {
      const lab = new THREE.Mesh(new THREE.PlaneGeometry(4, 1), new THREE.MeshBasicMaterial({ map: signTex(r.pick(['ATMEGA328', 'LM358', 'NE555', 'ESP32-S3', '74HC595', 'STM32F4']), '#141414', '#d8d8d8') }));
      lab.userData.owned = true;
      lab.rotation.x = -Math.PI / 2;
      lab.position.set(r.range(-R * 0.6, R * 0.6), 0.05, r.range(-R * 0.6, R * 0.2));
      g.add(lab);
    }
  }

  // ------------------------------------------------------------ food: a macro surface

  private *food() {
    const R = this.radius, r = this.r, k = this.k, g = this.group;
    const col = ownColour(this.desc.source, '#c8924a');
    const base = new THREE.Color(col);
    const kit = new Kit();
    kit.cyl(mat(col, { rough: 0.8 }), R + 2, R + 2, 0.3, 0, -0.3, 0, 48);
    kit.finish(g);
    yield;
    const inDisc = () => { const a = r.range(0, Math.PI * 2), d = Math.sqrt(r.next()) * R; return [Math.cos(a) * d, Math.sin(a) * d]; };
    // crumb and swells of the surface (1-6 mm), seeds (3 mm), sugar crystals (0.5 mm), droplets (2 mm)
    scatter(g, unitSphere, mat('#ffffff', { rough: 0.85 }), 180, () => { const [x, z] = inDisc(); const s = r.range(0.001, 0.006) * k; if (s > 1.2 && Math.hypot(x, z - R * 0.55) > 3) this.cols.push({ minX: x - s * 0.7, maxX: x + s * 0.7, minZ: z - s * 0.7, maxZ: z + s * 0.7 }); return [x, -s * 0.5, z, s, s * r.range(0.5, 0.9), s, r.range(0, 6)]; }, () => base.clone().offsetHSL(0, r.range(-0.05, 0.05), r.range(-0.08, 0.05)));
    scatter(g, unitSphere, mat('#3a2a18', { rough: 0.5 }), 40, () => { const [x, z] = inDisc(); const s = 0.0015 * k; return [x, s * 0.3, z, s * 0.6, s * 0.4, s, r.range(0, 6)]; });
    scatter(g, unitBox, mat('#ffffff', { rough: 0.15 }), 300, () => { const [x, z] = inDisc(); const s = r.range(0.0003, 0.0007) * k; return [x, s * 0.4, z, s, s, s, r.range(0, 6), r.range(0, 1)]; });
    scatter(g, unitSphere, new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.02, transparent: true, opacity: 0.35 }), 25, () => { const [x, z] = inDisc(); const s = r.range(0.001, 0.003) * k; return [x, 0, z, s, s * 0.45, s]; });
  }

  // ------------------------------------------------------------ anything else: its own surface

  private *surface() {
    const R = this.radius, r = this.r, k = this.k, g = this.group;
    const col = ownColour(this.desc.source, '#9a8e7c');
    const kit = new Kit();
    kit.cyl(mat(col, { rough: 0.7 }), R + 30, R + 30, 0.3, 0, -0.3, 0, 48);
    kit.finish(g);
    yield;
    // the object itself, as the mountain range on the horizon
    const sp = this.model(-0.5, 0, -R * 0.45);
    if (sp) {
      const hx = sp.size.x / 2, hz = sp.size.z / 2;
      this.cols.push({ minX: -hx, maxX: hx, minZ: -R * 0.45 - hz, maxZ: -R * 0.45 + hz });
    }
    yield;
    // boulders and grit of the same stuff (scratches and dust at the old scale)
    const c0 = new THREE.Color(col);
    scatter(g, unitIco, mat('#ffffff', { rough: 0.8 }), 70, () => { const a = r.range(0, 6.28), d = r.range(6, R); const x = Math.cos(a) * d, z = Math.sin(a) * d; const s = r.range(0.0005, 0.004) * k; if (s > 0.8 && Math.hypot(x, z - R * 0.55) > 4) this.cols.push({ minX: x - s * 0.7, maxX: x + s * 0.7, minZ: z - s * 0.7, maxZ: z + s * 0.7 }); return [x, 0, z, s, s * 0.6, s, r.range(0, 6)]; }, () => c0.clone().offsetHSL(0, 0, r.range(-0.15, 0.1)));
    scatter(g, unitIco, mat('#ffffff', { rough: 1 }), 900, () => { const a = r.range(0, 6.28), d = Math.sqrt(r.next()) * R; const s = r.range(0.00005, 0.0003) * k; return [Math.cos(a) * d, 0, Math.sin(a) * d, s, s * 0.5, s, r.range(0, 6)]; }, () => c0.clone().offsetHSL(0, 0, r.range(-0.2, 0.05)));
  }
}
