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
import { M } from './rooms/mats';

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

/** the inside face of an open cylinder (pot rim, a jar's wall): seen from within */
const innerMats = new Map<string, THREE.MeshStandardMaterial>();
function inner(color: string, rough: number) {
  let m = innerMats.get(color + rough);
  if (!m) innerMats.set(color + rough, (m = new THREE.MeshStandardMaterial({ color, roughness: rough, side: THREE.BackSide })));
  return m;
}

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

// ---------------------------------------------------------------- circuit textures

/** solder mask with silkscreen outlines, reference designators and vias; one repeat = `pitch` metres */
function pcbMaterial(seed: number, pitch: number) {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  const r = new Rng(hashN(seed, 77));
  g.fillStyle = '#1f5c3b';
  g.fillRect(0, 0, 512, 512);
  // faint glass-weave in the mask
  g.fillStyle = 'rgba(0,0,0,0.05)';
  for (let i = 0; i < 512; i += 8) g.fillRect(i, 0, 2, 512);
  // silkscreen: component outlines, pin-1 marks, reference designators
  g.strokeStyle = '#e8eee6';
  g.fillStyle = '#e8eee6';
  g.lineWidth = 3;
  g.font = 'bold 22px monospace';
  for (let i = 0; i < 10; i++) {
    const x = r.range(20, 400), y = r.range(30, 440), w = r.range(40, 110), h = r.range(24, 70);
    g.strokeRect(x, y, w, h);
    g.beginPath();
    g.arc(x + 8, y + 8, 3, 0, Math.PI * 2);
    g.fill();
    g.fillText(r.pick(['R', 'C', 'U', 'D', 'Q', 'L', 'J']) + r.int(1, 48), x, y - 6);
  }
  // vias: gold rings with a dark hole
  for (let i = 0; i < 40; i++) {
    const x = r.range(0, 512), y = r.range(0, 512);
    g.fillStyle = '#c8a050';
    g.beginPath();
    g.arc(x, y, 6, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#1a1208';
    g.beginPath();
    g.arc(x, y, 2.5, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1 / (pitch * 2), 1 / (pitch * 2));
  t.anisotropy = 8;
  // solder mask is glossy over the copper
  return new THREE.MeshPhysicalMaterial({ map: t, roughness: 0.45, clearcoat: 0.7, clearcoatRoughness: 0.25 });
}
const chipLabels = new Map<string, THREE.Material>();
/** a chip's laser-etched part number */
function chipLabel(text: string) {
  let m = chipLabels.get(text);
  if (!m) {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 128;
    const g = c.getContext('2d')!;
    g.fillStyle = '#161616';
    g.fillRect(0, 0, 512, 128);
    g.fillStyle = '#b8bcc0';
    g.font = 'bold 64px monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 256, 52, 490);
    g.font = '28px monospace';
    g.fillText('2219 · ' + ((text.length * 7919) % 9000 + 1000), 256, 106);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    chipLabels.set(text, (m = new THREE.MeshStandardMaterial({ map: t, roughness: 0.6 })));
  }
  return m;
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
  /** dust motes drifting in the light (garden) */
  private motes: THREE.Points | null = null;
  /** the object's own model, loading, whose material the vessel walls take (vessel) */
  private skin: { obj: THREE.Object3D; wall: THREE.MeshStandardMaterial; done: boolean } | null = null;
  private clock = 0;
  /** first view: face the most striking thing (x, z, height to look at) */
  focus = new THREE.Vector3();
  private face(x: number, z: number, y = 2) {
    const s = this.spawn.pos;
    this.spawn.yaw = Math.atan2(-(x - s.x), -(z - s.z));
    this.focus.set(x, y, z);
  }
  private r: Rng;

  constructor(public desc: MacroDesc, opts: { staged?: boolean } = {}) {
    this.mode = (desc.mode as MacroMode) in SPAN ? (desc.mode as MacroMode) : 'surface';
    this.k = SPAN[this.mode] / Math.max(0.02, desc.sourceScale);
    this.radius = this.mode === 'circuit' ? 70 : this.mode === 'surface' ? 90 : this.mode === 'food' ? 60 : this.mode === 'vessel' ? 17 : 26;
    // a plant model usually stands in its own pot: the walkable soil is inside the pot (its footprint)
    const e = desc.source;
    if (this.mode === 'garden' && e) {
      const foot = (Math.min(e.size[0], e.size[2]) / Math.max(...e.size)) * desc.sourceScale * this.k;
      this.radius = Math.max(8, Math.min(26, foot * 0.4));
    }
    this.name = desc.name;
    this.r = new Rng(hashN(desc.seed, 3301));
    const dark = this.mode === 'vessel' || this.mode === 'circuit';
    // a room far above / around: warm, dim, a lamp for a sun
    this.env = {
      // the room above: a lit ceiling over an open device, dim over a jar's mouth
      skyTop: this.mode === 'circuit' ? '#8a9098' : dark ? '#141210' : '#5a5348', skyBottom: this.mode === 'circuit' ? '#c4c8ce' : dark ? '#2a2620' : '#b8ab94', stars: false,
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
    this.clock += dt;
    if (this.motes) {
      const p = this.motes.geometry.getAttribute('position') as THREE.BufferAttribute;
      const t = this.clock;
      for (let i = 0; i < p.count; i++) p.setY(i, ((p.getY(i) + dt * 0.15) % 30) + Math.sin(t + i) * 0.002);
      p.needsUpdate = true;
    }
    if (this.skin && !this.skin.done) this.takeSkin();
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
    kit.cyl(inner(ownColour(this.desc.source, '#b5643f'), 0.85), R + 3.2, R + 2.6, Math.max(4, 0.03 * k), 0, -0.2, 0, 48, true);
    kit.finish(g);
    yield;
    // (most 'plant' models are the planter itself: its rim is the wall above, in its own colour; the
    // model is not placed — its own soil or handles would be a ceiling over your head at this scale)
    const e = this.desc.source;
    // what grows in it: a mix of seedlings 3-12 cm tall (fern fronds, clover, grass tufts, broad-leaved
    // sprouts), their stems as trunks and their leaves as canopies: leaf cards with a leaf texture
    const pk = new Kit();
    const green = new THREE.Color(ownColour(e, '#4f7a3a'));
    if (green.g < green.r || green.g < 0.25) green.set('#4f7a3a');
    const stemM = mat('#6f8a3a', { rough: 0.7 });
    const leafCard = M.leaf();
    const leafM = mat('#' + green.getHexString(), { rough: 0.55 });
    const grassM = mat('#7a9a3a', { rough: 0.6 });
    let tallest = { x: 0, z: -R * 0.3, h: 0 };
    const stem = (x: number, z: number, h: number, rr: number, lean: number, tilt: number) => {
      let px = x, pz = z, py = 0;
      for (let sgm = 0; sgm < 3; sgm++) {
        const len = h / 3;
        const dx = Math.cos(lean) * Math.sin(tilt * (sgm + 1)) * len, dz = Math.sin(lean) * Math.sin(tilt * (sgm + 1)) * len;
        pk.boxM(stemM, rr * 2 * (1 - sgm * 0.2), len * 1.05, rr * 2 * (1 - sgm * 0.2), px + dx / 2, py + len / 2, pz + dz / 2, new THREE.Euler(Math.atan2(dz, len), 0, -Math.atan2(dx, len)));
        px += dx; pz += dz; py += len * Math.cos(tilt * (sgm + 1));
      }
      return [px, py, pz];
    };
    const n = r.int(6, 10);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + r.range(-0.3, 0.3), d = r.range(0.12, 0.7) * R;
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      if (Math.hypot(x, z - R * 0.55) < 3) continue;
      const kind = i % 4;
      const h = (kind === 2 ? r.range(0.02, 0.05) : r.range(0.04, 0.12)) * k, rr = r.range(0.0008, 0.0016) * k;
      if (h > tallest.h && Math.hypot(x, z - R * 0.55) > R * 0.25) tallest = { x, z, h };
      if (kind === 0) {
        // fern: an arching stem with fronds of leaf cards along it
        const [tx, ty, tz] = stem(x, z, h * 0.7, rr, r.range(0, 6.28), r.range(0.1, 0.25));
        for (let f = 0; f < 7; f++) {
          const fa = (f / 7) * Math.PI * 2, fl = h * r.range(0.35, 0.5);
          pk.at(tx, ty - fl * 0.1, tz, fa, () => {
            for (let q = 0; q < 5; q++) pk.boxM(leafCard, fl * 0.32, 0.002, fl * 0.2, 0, -q * fl * 0.05, -(q + 0.5) * fl * 0.2, new THREE.Euler(0.15 + q * 0.12, 0, 0));
          });
        }
      } else if (kind === 1) {
        // clover: thin stalks, three round leaflets each
        for (let c = 0; c < 3; c++) {
          const ox = x + r.range(-1, 1) * h * 0.2, oz = z + r.range(-1, 1) * h * 0.2;
          const [tx, ty, tz] = stem(ox, oz, h * r.range(0.6, 1), rr * 0.6, r.range(0, 6.28), r.range(0.05, 0.15));
          for (let l = 0; l < 3; l++) {
            const la = (l / 3) * Math.PI * 2;
            pk.sphere(leafM, h * 0.14, tx + Math.cos(la) * h * 0.12, ty, tz + Math.sin(la) * h * 0.12, 0.1);
          }
        }
      } else if (kind === 2) {
        // grass tuft: tapering blades fanning out
        for (let b = 0; b < 9; b++) {
          const ba = r.range(0, 6.28), bt = r.range(0.1, 0.45);
          pk.boxM(grassM, rr * 2.5, h, rr * 0.4, x + Math.cos(ba) * h * 0.15, h / 2, z + Math.sin(ba) * h * 0.15, new THREE.Euler(Math.sin(ba) * bt, ba, Math.cos(ba) * bt));
        }
      } else {
        // broad-leaved sprout: a stem, two seed leaves and true leaves as leaf cards
        const [tx, ty, tz] = stem(x, z, h, rr, r.range(0, 6.28), r.range(0.05, 0.2));
        for (let l = 0; l < 6; l++) {
          const la = (l / 6) * Math.PI * 2 + r.range(0, 0.5), lr = h * r.range(0.25, 0.4);
          pk.at(tx, ty - lr * 0.1, tz, la, () => pk.boxM(l < 2 ? leafM : leafCard, lr * 0.7, 0.002, lr, 0, 0, -lr * 0.5, new THREE.Euler(0.35, 0, 0)));
        }
      }
      this.cols.push({ minX: x - rr * 2, maxX: x + rr * 2, minZ: z - rr * 2, maxZ: z + rr * 2 });
    }
    pk.finish(g);
    this.face(tallest.x, tallest.z, Math.min(3, tallest.h * 0.3));
    // a shaft of window light falling into the pot, and dust motes drifting in it
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(R * 0.05, R * 0.25, 0.06 * k, 24, 1, true),
      new THREE.MeshBasicMaterial({ color: '#fff1d0', transparent: true, opacity: 0.035, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }),
    );
    shaft.userData.owned = true;
    shaft.position.set(tallest.x * 0.5, 0.03 * k, tallest.z * 0.5);
    shaft.rotation.z = 0.25;
    g.add(shaft);
    const mp: number[] = [];
    for (let i = 0; i < 400; i++) mp.push(r.range(-R, R) * 0.6 + tallest.x * 0.4, r.range(0.5, 30), r.range(-R, R) * 0.6 + tallest.z * 0.4);
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.Float32BufferAttribute(mp, 3));
    this.motes = new THREE.Points(mg, new THREE.PointsMaterial({ color: '#fff4dc', size: 0.06, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.motes.userData.owned = true;
    g.add(this.motes);
    yield;
    // soil grains (0.2-1 mm), perlite (white, 2-4 mm), pebbles (5-12 mm), moss cushions
    const inDisc = () => { const a = r.range(0, Math.PI * 2), d = Math.sqrt(r.next()) * R; return [Math.cos(a) * d, Math.sin(a) * d]; };
    scatter(g, unitIco, mat('#4a3423', { rough: 1 }), 2500, () => { const [x, z] = inDisc(); const s = r.range(0.0002, 0.001) * k; return [x, 0, z, s, s * 0.7, s, r.range(0, 6)]; }, () => new THREE.Color().setHSL(0.07, 0.35, r.range(0.08, 0.2)));
    scatter(g, unitIco, mat('#e2d8c8', { rough: 0.9 }), 40, () => { const [x, z] = inDisc(); const s = r.range(0.002, 0.004) * k; return [x, s * 0.3, z, s, s * 0.8, s, r.range(0, 6)]; });
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
      this.ants.push({ o, a: r.range(0, 6.28), r: r.range(R * 0.2, R * 0.85), v: r.range(0.008, 0.02) * k * (r.chance(0.5) ? 1 : -1) });
    }
  }

  // ------------------------------------------------------------ inside a container

  private *vessel() {
    const R = this.radius, r = this.r, k = this.k, g = this.group;
    const e = this.desc.source;
    const col = ownColour(e, r.pick(['#d8d2c4', '#8a6a4a', '#5a7a9a', '#c9c4bc']));
    const round = e ? Math.abs(e.size[0] - e.size[2]) / Math.max(e.size[0], e.size[2]) < 0.2 : true;
    const H = Math.max(8, (e ? e.size[1] / Math.max(...e.size) : 1) * this.desc.sourceScale * k);
    // the walls take the object's own material once its model has loaded (takeSkin); its colour until then
    const wall = new THREE.MeshStandardMaterial({ color: col, roughness: 0.45, side: round ? THREE.BackSide : THREE.FrontSide });
    if (e) {
      const sp = spawn(e, 1);
      this.skin = { obj: sp.obj, wall, done: false };
    }
    const floorM = mat(new THREE.Color(col).multiplyScalar(0.8).getStyle(), { rough: 0.6 });
    const kit = new Kit();
    if (round) {
      kit.cyl(floorM, R + 1, R + 1, 0.3, 0, -0.3, 0, 48);
      kit.cyl(wall, R + 1.2, R + 1.2, H, 0, -0.3, 0, 48, true);
      kit.cyl(wall, R + 1.6, R + 1.6, 0.4, 0, H - 0.4, 0, 48, true);
      // the rim catching the light: a bright curved edge high above
      kit.unshadowed(() => kit.cyl(mat('#fff2dc', { emissive: '#fff2dc', ei: 1.6 }), R + 1.25, R + 1.25, 0.25, 0, H - 0.6, 0, 48, true));
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
      // (contents laid out for a 0.8 m cabinet, scaled to fill this one's floor)
      const c = cabinetContents(this.desc.seed, 0.8, 0.9, 0.5);
      const cs = (R * 1.5) / 0.8;
      c.scale.setScalar(cs);
      c.position.set(0, -0.13 * cs, -R * 0.2 + 0.25 * cs); // its lower shelf is the floor you stand on
      g.add(c);
      this.cols.push({ minX: -0.4 * cs, maxX: 0.4 * cs, minZ: -R * 0.2 - 0.25 * cs, maxZ: -R * 0.2 + 0.25 * cs });
    } else {
      // coins (24 mm), buttons (15 mm), crumbs, a paper clip's worth of wire, dust
      const inDisc = (m = 0.9) => { const a = r.range(0, Math.PI * 2), d = Math.sqrt(r.next()) * R * m; return [Math.cos(a) * d, Math.sin(a) * d]; };
      scatter(g, unitCyl, mat('#b8925a', { rough: 0.3, metal: 0.9 }), 9, () => { const [x, z] = inDisc(); const s = 0.012 * k; this.cols.push({ minX: x - s * 0.7, maxX: x + s * 0.7, minZ: z - s * 0.7, maxZ: z + s * 0.7 }); return [x, 0.001 * k, z, s, 0.0018 * k, s, 0, r.range(-0.1, 0.1)]; });
      scatter(g, unitCyl, mat('#ffffff', { rough: 0.4 }), 12, () => { const [x, z] = inDisc(); const s = 0.0075 * k; return [x, 0.0012 * k, z, s, 0.0025 * k, s]; }, () => new THREE.Color(r.pick(['#e8e2d6', '#3a2a20', '#8a2a2a', '#2a3a5a', '#d8c070'])));
      scatter(g, unitIco, mat('#d8c8a8', { rough: 0.9 }), 400, () => { const [x, z] = inDisc(0.98); const s = r.range(0.0003, 0.0015) * k; return [x, 0, z, s, s * 0.6, s, r.range(0, 6)]; });
    }
    this.spawn.pos.set(0, 0, R * 0.6);
    // look across the floor at what is in it, the wall and its lit rim beyond
    this.face(0, -R * 0.2, Math.min(4, H * 0.15));
  }

  /** vessel walls: the object's own material (map, colour, roughness) once its model is in */
  private takeSkin() {
    const sk = this.skin!;
    let src: THREE.MeshStandardMaterial | null = null;
    sk.obj.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (!src && m && (m as THREE.MeshStandardMaterial).isMeshStandardMaterial) src = m;
    });
    if (!src) return;
    const m = src as THREE.MeshStandardMaterial;
    sk.done = true;
    sk.wall.color.copy(m.color);
    sk.wall.roughness = m.roughness;
    sk.wall.metalness = m.metalness;
    if (m.map) {
      const t = m.map.clone();
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(6, 2);
      t.needsUpdate = true;
      sk.wall.map = t;
      sk.wall.needsUpdate = true;
    }
  }

  // ------------------------------------------------------------ a circuit board

  private *circuit() {
    const R = this.radius, r = this.r, k = this.k, g = this.group;
    const kit = new Kit();
    const pcb = pcbMaterial(this.desc.seed, Math.max(6, 0.00254 * k * 3));
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
    // the big ICs: packages the size of blocks with their part number on top, legible from the street
    let firstIc = { x: 0, z: 0, h: 0 };
    const labels = ['ATMEGA328P', 'STM32F407', 'ESP32-S3', 'LM358N', 'NE555P', '74HC595'];
    const big: [number, number][] = [];
    for (let i = 0; i < 6; i++) {
      // the first one stands just ahead of where you arrive, its part number legible
      const bx = i === 0 ? 3 : r.range(-R * 0.6, R * 0.6), bz = i === 0 ? R * 0.55 - 11 : r.range(-R * 0.7, R * 0.15);
      const w = 0.01 * k, d = 0.01 * k, h = Math.max(1.0, 0.0012 * k);
      kit.box(chip, w, h, d, bx, 0, bz);
      for (let p = 0; p < 10; p++) for (const sx of [-1, 1]) {
        kit.box(solder, 0.35, h * 0.35, 1.1, bx - w / 2 + (p + 0.5) * (w / 10), 0, bz + sx * (d / 2 + 0.55));
        kit.box(solder, 1.1, h * 0.35, 0.35, bx + sx * (w / 2 + 0.55), 0, bz - d / 2 + (p + 0.5) * (d / 10));
      }
      kit.flat(chipLabel(labels[i % labels.length]), w * 0.9, w * 0.24, bx, h + 0.01, bz, 'keep');
      if (i === 0) firstIc = { x: bx, z: bz, h };
      kit.sphere(mat('#444444', { rough: 0.4 }), w * 0.04, bx - w * 0.38, h, bz - d * 0.38, 0.2);
      this.cols.push({ minX: bx - w / 2 - 1.2, maxX: bx + w / 2 + 1.2, minZ: bz - d / 2 - 1.2, maxZ: bz + d / 2 + 1.2 });
      big.push([bx, bz]);
    }
    // heat sinks: aluminium fin towers, the skyscrapers of the board
    const alu = mat('#c9ccd0', { rough: 0.35, metal: 0.85 });
    let tower = { x: 0, z: -R * 0.5, h: 0 };
    for (let i = 0; i < 3; i++) {
      const hx = r.range(-R * 0.5, R * 0.5), hz = -R * r.range(0.2, 0.8);
      const hw = 0.012 * k, hh = 0.02 * k * r.range(0.7, 1.3);
      kit.box(alu, hw, hh * 0.08, hw, hx, 0, hz);
      const fins = 14;
      for (let f = 0; f < fins; f++) kit.box(alu, hw, hh, hw * 0.02, hx, 0, hz - hw / 2 + (f + 0.5) * (hw / fins));
      this.cols.push({ minX: hx - hw / 2, maxX: hx + hw / 2, minZ: hz - hw / 2, maxZ: hz + hw / 2 });
      if (hh > tower.h) tower = { x: hx, z: hz, h: hh };
    }
    // the device's own housing as the distant walls of this city: low panels in its colour (lightened), with
    // vent slots and panel seams; no roof, the room's light falls in
    const hc = new THREE.Color(ownColour(this.desc.source, '#5a5e64')).lerp(new THREE.Color('#9aa0a8'), 0.45);
    const housing = mat('#' + hc.getHexString(), { rough: 0.55, metal: 0.2 });
    const slot = mat('#1a1c20', { rough: 0.8 });
    const HW = R * 1.3, HH = 16;
    for (const [x, z, w, d] of [[0, -HW, HW * 2, 1], [0, HW, HW * 2, 1], [-HW, 0, 1, HW * 2], [HW, 0, 1, HW * 2]] as const) {
      kit.box(housing, w, HH, d, x, -0.2, z);
      const along = w > d;
      for (let t = -HW + 6; t < HW - 6; t += 12) {
        // a seam between panels and a bank of vent slots
        if (along) kit.box(slot, 0.25, HH, 1.1, t + 6, -0.2, z);
        else kit.box(slot, 1.1, HH, 0.25, x, -0.2, t + 6);
        for (let v = 0; v < 5; v++) {
          if (along) kit.box(slot, 7, 0.35, 1.1, t, 8 + v * 1.1, z);
          else kit.box(slot, 1.1, 0.35, 7, x, 8 + v * 1.1, t);
        }
      }
    }
    // just ahead of where you arrive: an upright TO-220 regulator, its part number printed on its face,
    // its metal tab above and three legs into the board
    {
      const w = 0.01 * k, bh = 0.009 * k, d = 0.0045 * k, lift = 0.003 * k, x = -2, z = this.spawn.pos.z - 10;
      kit.box(chip, w, bh, d, x, lift, z);
      kit.box(alu, w, 0.006 * k, 0.0013 * k, x, lift + bh, z - d / 2 + 0.0007 * k);
      kit.cyl(mat('#1a1c20'), 0.0018 * k, 0.0018 * k, 0.0014 * k, x, lift + bh + 0.002 * k, z - d / 2 + 0.0007 * k, 16);
      for (const lx of [-1, 0, 1]) kit.box(solder, 0.0008 * k, lift + 0.2, 0.0005 * k, x + lx * 0.00254 * k, 0, z);
      kit.quad(chipLabel('LM7805CT'), w * 0.85, w * 0.23, x, lift + bh * 0.62, z + d / 2 + 0.02, 0);
      kit.quad(chipLabel('LM7805CT'), w * 0.85, w * 0.23, x, lift + bh * 0.62, z - d / 2 - 0.02, Math.PI);
      this.cols.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
      firstIc = { x, z, h: lift + bh * 0.62 };
    }
    kit.finish(g);
    void tower;
    this.face(firstIc.x, firstIc.z, firstIc.h);
    void big;
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
