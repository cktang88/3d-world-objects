import * as THREE from 'three';
import type { Env, Level, LevelDesc, Portal, Rect } from './level';
import { mat } from './build';
import { realScale } from './realscale';
import { Rng, hashN } from './rng';
import { loadPools } from './museumData';
import { loadRemote, isRebuilt, clearQueue, disposeModel, DATASET_LABEL, type RemoteEntry, type RemoteModel } from './remote';
import { SHOPS } from './nyc';
import { bake } from './nyc/common';
import { loadOriginal } from './detail';
import { Kit, M, quad, surfMat, lit, type Seg, type Container } from './shopkit/kit';
import { dropTile, tinTile, textTex } from './shopkit/tex';
import { LAYOUTS, type Style } from './shopkit/layouts';
import { Filler, KINDS, SHOP_KINDS, COOLER_KINDS, type Kind } from './shopkit/filler';
import { DRINK } from './shopkit/fixtures';
import { searchLibrary, loadLibraryModel, type LibraryEntry, type LibraryQuery } from './libraries';

/**
 * A shop interior, laid out per kind of shop after real NYC stores (docs/research/shops.md):
 * bodegas with coolers, a deli counter and a cat; pharmacies with aisles under a drop ceiling;
 * hardware stores with pegboard and a library ladder; guitar walls; antique clutter under
 * pressed tin. Fixtures make product segments; products from the shop's sand3d pools are
 * packed into them at real size (fronted rows, stacks, piles, hooks) and instanced.
 */

interface Slot {
  p: THREE.Vector3;
  rot: number;
  s: number;
}
interface Loaded {
  /** a sand3d object (inspectable, may have an Objaverse original) */
  e?: RemoteEntry;
  /** or a real scanned product / prop from a model library (GSO, Poly Haven) */
  lib?: LibraryEntry;
  title: string;
  obj: THREE.Object3D;
  size: THREE.Vector3;
  tris: number;
  /** scale to real size */
  k: number;
  /** real dimensions */
  dim: THREE.Vector3;
  chunks: number;
}

/** product triangle budget per shop (the lab lowers it for software rendering) */
/**
 * Real scanned / photogrammetry products each kind of shop also stocks: Google Scanned Objects
 * (CC BY) for packaged retail goods, Poly Haven (CC0) for tools, decor, plants, lamps, furniture.
 */
const LIB_QUERIES: Record<string, LibraryQuery[]> = {
  deli: [{ source: 'gso', category: ['food and drink', 'bottles and cups'], maxSize: 0.6, limit: 9 }],
  pharmacy: [{ source: 'gso', category: ['health and beauty', 'household', 'baby gear'], maxSize: 0.6, limit: 9 }],
  electronics: [{ source: 'gso', category: ['electronics', 'media'], maxSize: 0.6, limit: 8 }, { source: 'polyhaven', category: 'electronics & appliances', maxSize: 0.8, limit: 3 }],
  toys: [{ source: 'gso', category: ['toy', 'board game'], maxSize: 0.6, limit: 9 }],
  kitchen: [{ source: 'gso', category: ['kitchen', 'bottles and cups'], maxSize: 0.6, limit: 7 }, { source: 'polyhaven', category: 'food & kitchen', maxSize: 0.6, limit: 3 }],
  sports: [{ source: 'gso', category: ['shoe', 'bag'], maxSize: 0.6, limit: 7 }],
  stationery: [{ source: 'gso', category: ['media', 'board game'], maxSize: 0.6, limit: 6 }, { source: 'polyhaven', category: 'office & stationery', maxSize: 0.6, limit: 3 }],
  music: [{ source: 'gso', category: 'media', maxSize: 0.6, limit: 4 }],
  hardware: [{ source: 'gso', category: 'household', maxSize: 0.6, limit: 4 }, { source: 'polyhaven', category: 'tools & equipment', maxSize: 1.0, limit: 5 }],
  antiques: [{ source: 'polyhaven', category: ['decor & art', 'containers & storage', 'lighting', 'electronics & appliances'], maxSize: 1.0, limit: 10 }, { source: 'polyhaven', category: 'furniture', maxSize: 2.0, limit: 3 }],
  garden: [{ source: 'polyhaven', category: 'nature', maxSize: 1.6, limit: 8 }],
  furniture: [{ source: 'polyhaven', category: 'furniture', maxSize: 2.4, limit: 6 }],
  lighting: [{ source: 'polyhaven', category: 'lighting', maxSize: 2.0, limit: 6 }],
  machines: [{ source: 'polyhaven', category: ['tools & equipment', 'industrial & infrastructure'], maxSize: 1.5, limit: 5 }],
};
const LIB_NAME: Record<string, string> = { gso: 'Google Scanned Objects', polyhaven: 'Poly Haven', smithsonian: 'Smithsonian', khronos: 'Khronos' };

export const SHOP_BUDGET = { tris: 2_500_000 };

export class ShopLevel implements Level {
  name: string;
  group = new THREE.Group();
  spawn = { pos: new THREE.Vector3(), yaw: 0 };
  env: Env = {
    skyTop: '#1a1a1a', skyBottom: '#222', stars: false, fog: null, fogNear: 0, fogFar: 0, sun: null,
    hemi: { sky: '#f4f8ff', ground: '#6a6458', intensity: 0.5 }, ambient: 0.06, envIntensity: 0.5, exposure: 0.82,
  };
  /**
   * The street door in level coordinates: the centre of its threshold on the shop-front plane,
   * with the yaw of the outward normal (the shop front faces +z, so yaw 0). The door is 1.6 m
   * wide and 2.6 m tall; the room spans x in [-room.W/2, room.W/2], z in [-room.D/2, room.D/2].
   */
  door = { pos: new THREE.Vector3(), yaw: 0, width: 1.6, height: 2.6 };
  room = { W: 0, D: 0, H: 0 };
  /** resolves once the stock has been placed (for the lab) */
  stocked: Promise<void> = Promise.resolve();
  private cols: Rect[] = [];
  private ports: Portal[] = [];
  private alive = true;
  private models: RemoteModel[] = [];
  /** triangles we are willing to spend on products (sand3d instances and swapped-in originals) */
  private triBudget = SHOP_BUDGET.tris;
  /** stats for the lab */
  stats = { products: 0, slots: 0, tris: 0, originals: 0, filler: 0 };
  private prio = 0;
  /**
   * Glass-fronted containers (coolers, showcases, curio cabinets, deli cases). Their stock is
   * not generated until generate() is called: update() does it when the player comes near
   * and stands in front of one; a seamless-entry system may call it earlier or later.
   */
  containers: (Container & { generated: boolean; generate: () => void })[] = [];

  constructor(desc: Extract<LevelDesc, { kind: 'interior' }>) {
    this.name = desc.name;
    const r = new Rng(hashN(desc.seed, 31));
    const type = desc.shop ?? 'deli';
    const layout = LAYOUTS[type] ?? LAYOUTS.deli;
    const st = layout.style(r);
    const { W, D } = st;
    const kit = new Kit();
    const info = SHOPS.find((s) => s.type === type) ?? SHOPS[0];
    const doorX = layout.door?.(W, r) ?? 0;
    this.shell(kit, st, doorX, desc.name, info.colors[0], r);
    layout.build(kit, r, st, { doorX, name: desc.name, color: info.colors[0] });
    this.env = { ...this.env, ...st.env };
    // merge static fixtures into a handful of meshes
    const baked = bake(kit.stat);
    baked.traverse((o) => ((o as THREE.Mesh).isMesh ? ((o as THREE.Mesh).castShadow = false) : null));
    this.group.add(baked);
    this.group.add(kit.live);
    this.cols.push(...kit.cols);
    this.containers = kit.containers.map((c) => ({ ...c, generated: false, generate: () => {} }));
    this.spawn.pos.set(doorX, 0, D / 2 - 1.1);
    this.door.pos.set(doorX, 0, D / 2);
    this.room = { W, D, H: st.H };
    this.ports.push({ box: new THREE.Box3(new THREE.Vector3(doorX - 0.8, 0, D / 2 - 0.6), new THREE.Vector3(doorX + 0.8, 2.6, D / 2 + 0.3)), label: 'Back to the street', target: 'back' });
    this.stocked = this.stock(kit.segs, info.pools, desc.seed, r.fork(9), type);
  }

  // ---------------------------------------------------------------- the room

  private shell(k: Kit, st: Style, doorX: number, name: string, color: string, r: Rng) {
    const { W, D, H } = st;
    const T = 0.2;
    // floor
    const fl = quad(st.floor.m, W, D, st.floor.tile ?? [W, D]);
    fl.rotation.x = -Math.PI / 2;
    k.at(0, 0).add(fl);
    // walls (inner faces) and a baseboard
    const wm = st.wall;
    const walls: [number, number, number, number][] = [
      [0, -D / 2, W, 0], // back
      [-W / 2, 0, D, Math.PI / 2], // left
      [W / 2, 0, D, -Math.PI / 2], // right
    ];
    for (const [x, z, len, rot] of walls) {
      k.at(x, z, rot);
      k.face(wm.m, len, H, 0, H / 2, 0, wm.tile ?? [len, H]);
      k.box(mat(st.trim ?? '#2a2622', { rough: 0.6 }), len, 0.12, 0.02, 0, 0, 0.01);
    }
    this.cols.push({ minX: -W / 2 - 1, maxX: W / 2 + 1, minZ: -D / 2 - 1, maxZ: -D / 2 + 0.1 });
    this.cols.push({ minX: -W / 2 - 1, maxX: -W / 2 + 0.1, minZ: -D / 2 - 1, maxZ: D / 2 + 1 });
    this.cols.push({ minX: W / 2 - 0.1, maxX: W / 2 + 1, minZ: -D / 2 - 1, maxZ: D / 2 + 1 });
    // ceiling
    k.at(0, 0);
    if (st.ceil === 'drop') {
      const s = dropTile();
      const c = k.face(surfMat(s, { rough: 0.95, ns: 0.6 }), W, D, 0, H, 0, s.tile);
      c.rotation.x = Math.PI / 2;
    } else if (st.ceil === 'tin') {
      const s = tinTile(st.tin ?? '#efe9da');
      const c = k.face(surfMat(s, { rough: 0.45, metal: 0.35, ns: 1.2 }), W, D, 0, H, 0, s.tile);
      c.rotation.x = Math.PI / 2;
      // crown moulding round the top of the walls
      const cm = mat(st.tin ?? '#efe9da', { rough: 0.5, metal: 0.2 });
      k.box(cm, W, 0.18, 0.16, 0, H - 0.18, -D / 2 + 0.08);
      k.box(cm, 0.16, 0.18, D, -W / 2 + 0.08, H - 0.18, 0);
      k.box(cm, 0.16, 0.18, D, W / 2 - 0.08, H - 0.18, 0);
      k.box(cm, W, 0.18, 0.16, 0, H - 0.18, D / 2 - 0.08);
    } else if (st.ceil === 'exposed') {
      const dark = mat(st.ceilColor ?? '#1e1f21', { rough: 0.9 });
      const c = k.face(dark, W, D, 0, H + 0.4, 0);
      c.rotation.x = Math.PI / 2;
      for (let z = -D / 2 + 0.3; z < D / 2; z += 0.6) k.box(dark, W, 0.28, 0.06, 0, H + 0.12, z);
      k.cyl(mat('#8a8d90', { rough: 0.4, metal: 0.7 }), 0.22, D - 0.4, W / 4, H - 0.05, 0, 'z');
      k.box(dark, W, 0.04, 0.04, 0, H - 0.4, 0); // conduit
    } else {
      const c = k.face(mat(st.ceilColor ?? '#f2f0ea', { rough: 0.95 }), W, D, 0, H, 0);
      c.rotation.x = Math.PI / 2;
    }
    // shop front: windows onto the street and the door
    k.at(0, D / 2, Math.PI);
    const pane = mat('#dfeaf2', { emissive: '#e8f0f6', ei: 0.9, rough: 0.1 });
    const frame = mat('#2a2a2a', { metal: 0.4, rough: 0.5 });
    const dx = -doorX; // frame is turned round
    for (const [a, b] of [[-W / 2, dx - 0.8], [dx + 0.8, W / 2]]) {
      if (b - a < 0.05) continue;
      k.box(frame, b - a, 0.6, T, (a + b) / 2, 0, 0);
      k.box(pane, b - a, 2.4, 0.05, (a + b) / 2, 0.6, 0.05);
      k.box(st.wall.m, b - a, H - 3.0, T, (a + b) / 2, 3.0, 0);
      for (let x = a + 1.2; x < b - 0.3; x += 1.4) k.box(frame, 0.05, 2.4, 0.08, x, 0.6, 0.06);
    }
    k.box(st.wall.m, 1.6, H - 2.6, T, dx, 2.6, 0);
    k.box(mat('#3a3f44', { rough: 0.3, metal: 0.5 }), 1.5, 2.55, 0.06, dx, 0, -0.08);
    k.box(M.chrome(), 0.03, 0.5, 0.05, dx + 0.6, 0.85, 0.06);
    k.face(lit(textTex('EXIT', '#0c5a2a', '#e8ffe8', { w: 256, h: 96 })), 0.42, 0.16, dx, 2.85, 0.12);
    this.cols.push({ minX: -W / 2, maxX: doorX - 0.8, minZ: D / 2 - 0.1, maxZ: D / 2 + 1 });
    this.cols.push({ minX: doorX + 0.8, maxX: W / 2, minZ: D / 2 - 0.1, maxZ: D / 2 + 1 });
    // name on the back wall
    if (st.banner !== false) {
      k.at(0, -D / 2 + 0.11);
      k.face(lit(textTex(name.toUpperCase(), color, '#ffffff', { w: 1024, h: 160 })), Math.min(4, W * 0.5), 0.6, st.bannerX ?? 0, H - 0.55, 0);
    }
    // neon OPEN sign hanging in the window
    if (st.neon !== false) {
      const nx = doorX > 0 ? -W / 4 : W / 4;
      k.at(nx, D / 2 - 0.2, Math.PI);
      k.face(lit(textTex('OPEN', '', '#ff3355', { w: 256, h: 128, font: 'bold 90px system-ui, sans-serif' }), { transparent: true }), 0.6, 0.3, 0, 2.2, 0);
    }
    void r;
  }

  // ---------------------------------------------------------------- stock

  private async stock(segs: Seg[], pools: string[], seed: number, r: Rng, type: string) {
    const all = await loadPools();
    if (!this.alive) return;
    const stock: RemoteEntry[] = [];
    for (const key of pools) stock.push(...(all[key] ?? []));
    if (!stock.length || !segs.length) return;
    const pr = new Rng(hashN(seed, 5));
    pr.shuffle(stock);
    // products rebuilt with UV maps first: they take real textures best
    stock.sort((a, b) => Number(isRebuilt(b.id)) - Number(isRebuilt(a.id)));
    const chunks = this.chunk(segs, r);
    // photo-scanned real products (Google Scanned Objects, CC BY) for the kinds of shop that sell them
    const scanned = this.scanned(type, seed);
    const nWant = Math.max(10, Math.min(44, Math.round(chunks.length / 2.2)));
    const picks = stock.slice(0, Math.min(stock.length, nWant));
    // load them all (each finishes in its own time), then lay the shop out at once
    const timeout = new Promise<null>((res) => setTimeout(() => res(null), 20000));
    const loaded = (
      await Promise.all(picks.map((e, i) => Promise.race([loadRemote(e, { prio: i, shadows: false }).catch(() => null), timeout])))
    ).flatMap((m, i): Loaded[] => {
      if (!m) return [];
      if (!this.alive) {
        disposeModel(m.object);
        return [];
      }
      this.models.push(m);
      const e = picks[i];
      const k = realScale(e.title, e.entry, e.family, Math.max(m.size.x, m.size.y, m.size.z), e.ds);
      return [{ e, title: `${e.title} ${e.entry}`, obj: m.object, size: m.size, tris: m.tris, k, dim: m.size.clone().multiplyScalar(k), chunks: 0 }];
    });
    if (!this.alive) return;
    loaded.push(...(await scanned));
    if (!this.alive) return;
    const kinds = (SHOP_KINDS[type] ?? []).map((n) => KINDS[n]);
    const byProduct = this.assign(chunks, loaded, r, kinds.length > 0);
    // the open shop floor now; each container's contents only when it is generated
    const sets = new Map<number, Map<Loaded | 'filler', Seg[]>>();
    for (const [p, list] of byProduct)
      for (const sg of list) {
        const id = sg.box ?? -1;
        if (!sets.has(id)) sets.set(id, new Map());
        const m = sets.get(id)!;
        if (!m.has(p)) m.set(p, []);
        m.get(p)!.push(sg);
      }
    if (sets.has(-1)) this.stockSet(sets.get(-1)!, kinds, r);
    for (const c of this.containers) {
      const set = sets.get(c.id);
      if (!set) {
        c.generated = true;
        continue;
      }
      c.generate = () => {
        if (c.generated || !this.alive) return;
        c.generated = true;
        this.stockSet(set, kinds, new Rng(hashN(seed, 100 + c.id)));
      };
    }
  }

  /** place a set of products (and packaging for the rest) and instance them */
  private stockSet(set: Map<Loaded | 'filler', Seg[]>, kinds: Kind[], r: Rng) {
    const filler = new Filler();
    const rest: Seg[] = [...(set.get('filler') ?? [])];
    for (const [p, list] of set) if (p !== 'filler') rest.push(...this.place(p, list, r, this.prio++));
    for (const sg of rest) this.fill(filler, sg, kinds, r);
    filler.build(this.group);
    this.stats.filler += filler.count;
    this.stats.tris += filler.tris();
  }

  /** generic packaged goods in a segment: one kind per block, a few colourways */
  private fill(f: Filler, s: Seg, shopKinds: Kind[], r: Rng) {
    if (s.mode === 'single' || s.mode === 'ceil') return;
    const cooler = s.want === DRINK;
    const guitars = !!s.want?.source.startsWith('guitar');
    let pool = cooler ? COOLER_KINDS.map((n) => KINDS[n]) : guitars ? [KINDS.guitar] : shopKinds.filter((k) => k.geo !== 'guitar');
    if (s.mode === 'hang' && !guitars) pool = pool.filter((k) => k.d <= 0.08).concat(KINDS.blister);
    if (!pool.length) return;
    const fits = pool.filter((k) => k.h <= s.h && k.w <= s.len && k.d <= s.depth + (s.mode === 'hang' ? 0.3 : 0));
    if (!fits.length) return;
    // fill the height: prefer kinds that use most of the clearance
    const tall = fits.filter((k) => k.h >= s.h * 0.4);
    const kind = r.pick(tall.length ? tall : fits);
    const n = new THREE.Vector3(Math.sin(s.rot), 0, Math.cos(s.rot));
    const right = new THREE.Vector3(Math.cos(s.rot), 0, -Math.sin(s.rot));
    const messy = s.messy ?? 0.15;
    const { w, h, d } = kind;
    // a colourway: the kind's palette, shifted a little in hue and toned down per block
    const tone = () => {
      const c = new THREE.Color(r.pick(kind.colors));
      c.offsetHSL(r.range(-0.04, 0.04), r.range(-0.25, 0), r.range(-0.08, 0.04));
      return `#${c.getHexString()}`;
    };
    let color = tone(), left = 0;
    const next = () => {
      if (left-- <= 0) {
        color = tone();
        left = r.int(2, 6);
      }
      return color;
    };
    if (s.mode === 'shelf' || s.mode === 'stack') {
      const gap = 0.006 + messy * 0.01;
      const cols = Math.max(1, Math.floor((s.len + gap) / (w + gap)));
      const step = s.len / cols;
      const rows = Math.max(1, Math.min(s.want === DRINK ? 4 : 3, Math.floor(s.depth / (d + 0.004))));
      const layers = s.mode === 'stack' ? Math.max(1, Math.min(6, Math.floor(s.h / h))) : kind.geo !== 'bottle' && kind.geo !== 'bag' && h * 2 + 0.02 < s.h ? Math.min(3, Math.floor(s.h / (h + 0.003))) : 1;
      for (let i = 0; i < cols; i++) {
        const c = next();
        const depthHere = r.chance(0.08 + messy * 0.2) ? r.int(1, rows) : rows; // partly sold-through
        for (let j = rows - depthHere; j < rows; j++)
          for (let l = 0; l < layers; l++) {
            const jit = 0.003 + messy * 0.01;
            const pos = s.p.clone()
              .addScaledVector(right, -s.len / 2 + step * (i + 0.5) + r.range(-jit, jit))
              .addScaledVector(n, -(d / 2 + 0.004 + j * (d + 0.004)));
            pos.y += l * h;
            f.add(kind, pos, s.rot + r.range(-1, 1) * (0.015 + messy * 0.12), c);
          }
      }
    } else if (s.mode === 'hang') {
      const cols = Math.max(1, Math.floor((s.len + 0.04) / Math.max(w + 0.05, s.pitch ?? 0)));
      const rowsY = Math.max(1, Math.min(5, Math.floor((s.h + 0.06) / (h + 0.07))));
      const stepX = s.len / cols, stepY = s.h / rowsY;
      for (let i = 0; i < cols; i++) {
        const c = next();
        for (let j = 0; j < rowsY; j++) {
          if (r.chance(0.08)) continue;
          for (let q = 0; q < (s.pitch ? 1 : 3); q++) {
            const pos = s.p.clone()
              .addScaledVector(right, -s.len / 2 + stepX * (i + 0.5))
              .addScaledVector(n, d / 2 + 0.03 + q * (d + 0.006));
            pos.y += j * stepY + (stepY - h) * 0.75;
            f.add(kind, pos, s.rot, c);
          }
        }
      }
    } else if (s.mode === 'pile') {
      const count = Math.max(1, Math.min(60, Math.round(((s.len * s.depth) / (w * d)) * 0.9)));
      const layers = h * 2.2 < s.h ? 2 : 1;
      for (let i = 0; i < count; i++)
        for (let l = 0; l < layers; l++) {
          if (l > 0 && r.chance(0.5)) continue;
          const pos = s.p.clone()
            .addScaledVector(right, r.range(-1, 1) * Math.max(0, s.len / 2 - w / 2))
            .addScaledVector(n, -s.depth / 2 + r.range(-1, 1) * Math.max(0, s.depth / 2 - d / 2));
          pos.y += l * h * 0.9;
          f.add(kind, pos, messy > 0.7 ? r.range(0, Math.PI * 2) : s.rot + r.range(-1, 1) * (0.1 + messy * 0.5), next());
        }
    }
  }

  /** a handful of photo-scanned retail products for this kind of shop (cheap LOD, real size) */
  private async scanned(type: string, seed: number): Promise<Loaded[]> {
    const qs = LIB_QUERIES[type];
    if (!qs) return [];
    try {
      const hits = (await Promise.all(qs.map((q, i) => searchLibrary({ ...q, seed: hashN(seed, 77 + i) })))).flat();
      const objs = await Promise.all(hits.map((h) => loadLibraryModel(h, { quality: 'low', shadows: false }).catch(() => null)));
      return objs.flatMap((o, i): Loaded[] => {
        if (!o) return [];
        let tris = 0;
        o.traverse((x) => {
          const m = x as THREE.Mesh;
          if (m.isMesh) tris += (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute('position').count) / 3;
        });
        const size = (o.userData.size as THREE.Vector3).clone();
        return [{ lib: hits[i], title: `${hits[i].title} ${hits[i].category} ${hits[i].tags.join(' ')}`, obj: o, size, tris, k: 1, dim: size.clone(), chunks: 0 }];
      });
    } catch {
      return [];
    }
  }

  /** split long shelf / hook runs into product blocks */
  private chunk(segs: Seg[], r: Rng): Seg[] {
    const out: Seg[] = [];
    for (const s of segs) {
      if ((s.mode !== 'shelf' && s.mode !== 'hang' && s.mode !== 'stack') || s.len < 1.0 || s.want?.source.startsWith('guitar')) {
        out.push(s);
        continue;
      }
      const right = new THREE.Vector3(Math.cos(s.rot), 0, -Math.sin(s.rot));
      let a = 0;
      while (a < s.len - 0.05) {
        let l = Math.min(s.len - a, r.range(0.4, 1.1));
        if (s.len - a - l < 0.3) l = s.len - a;
        const p = s.p.clone().addScaledVector(right, -s.len / 2 + a + l / 2);
        out.push({ ...s, p, len: l });
        a += l;
      }
    }
    return out;
  }

  /** fraction of real size a product keeps in a segment */
  private fit(p: Loaded, s: Seg) {
    const d = p.dim;
    if (s.mode === 'hang') return Math.min(1, s.len / d.x, s.h / d.y, (s.depth + 0.15) / d.z);
    if (s.mode === 'ceil') return Math.min(1, 1.2 / Math.max(d.x, d.z), s.h / d.y);
    if (s.mode === 'single') return Math.min(1, s.len / Math.max(d.x, 0.01), s.depth / Math.max(d.z, 0.01), s.h / d.y);
    return Math.min(1, s.len / d.x, s.depth / d.z, s.h / d.y);
  }

  /** choose a product for each segment: one that fits near real size, wanted kinds first, in blocks */
  private assign(chunks: Seg[], ps: Loaded[], r: Rng, filler: boolean) {
    const map = new Map<Loaded | 'filler', Seg[]>();
    let prev: Loaded | 'filler' | null = null;
    for (const s of chunks) {
      let best: Loaded | 'filler' | null = null, bestScore = -Infinity;
      // generic packaging competes for shelf space (and wins coolers)
      if (filler && s.mode !== 'single' && s.mode !== 'ceil') {
        best = 'filler';
        bestScore = (s.want === DRINK ? 3.4 : s.want?.source.startsWith('guitar') ? 3.6 : s.mode === 'hang' ? 1.5 : 2.0) + r.next() * 0.8;
      }
      for (const p of ps) {
        const f = this.fit(p, s);
        let score = f >= 0.95 ? 2 : f >= 0.6 ? 1 + f : f * 1.5 - (s.big ? 0 : 1);
        if (s.mode === 'single' || s.mode === 'ceil') score += Math.min(1, Math.max(p.dim.x, p.dim.y, p.dim.z) / Math.max(s.len, 0.5)) * 1.5;
        if ((s.mode === 'single' || s.mode === 'ceil') && f < 0.35) score -= 2; // a shrunken ship on a plinth is a toy
        else {
          // tiny things on a big shelf read as empty: prefer things that fill it
          const fill = (p.dim.y * Math.min(1, f)) / s.h;
          score += Math.min(0.8, fill);
        }
        if (s.want && s.want.test(p.title)) score += 2.5;
        // a stick on a guitar hook / a pin on an antique shelf reads as empty
        if (s.pitch && p.dim.x * Math.min(1, f) < s.pitch * 0.45) score -= 2.5;
        if (p === prev && r.chance(0.35)) score += 1.2;
        score -= p.chunks * 0.12;
        score += r.next() * 0.6;
        if (score > bestScore) {
          bestScore = score;
          best = p;
        }
      }
      if (!best) continue;
      if (best !== 'filler') best.chunks++;
      prev = best;
      if (!map.has(best)) map.set(best, []);
      map.get(best)!.push(s);
    }
    return map;
  }

  /** pack one product into its segments and instance it */
  /** returns the segments it could not fill within the triangle budget (they get packaging) */
  private place(p: Loaded, segs: Seg[], r: Rng, prio: number): Seg[] {
    const slots: Slot[] = [];
    const boxes: THREE.Box3[] = [];
    const cords: THREE.Vector3[][] = [];
    const rejected: Seg[] = [];
    const sz = p.size;
    const tri = Math.max(1, p.tris);
    const cap = Math.min(450_000, this.triBudget);
    for (const s of segs) {
      const cordsBefore = cords.length;
      const f = this.fit(p, s);
      const sc = p.k * (s.mode === 'single' || s.mode === 'ceil' ? f : Math.max(f, s.big ? 0.3 : 0.12)) * (f < 1 ? 0.97 : 1);
      const w = sz.x * sc, h = sz.y * sc, d = sz.z * sc;
      const n = new THREE.Vector3(Math.sin(s.rot), 0, Math.cos(s.rot));
      const right = new THREE.Vector3(Math.cos(s.rot), 0, -Math.sin(s.rot));
      const messy = s.messy ?? 0.15;
      const before = slots.length;
      const put = (pos: THREE.Vector3, rot: number) => slots.push({ p: pos, rot, s: sc });
      if (s.mode === 'shelf' || s.mode === 'stack') {
        const gap = 0.008 + messy * 0.01;
        const cols = Math.max(1, Math.floor((s.len + gap) / Math.max(w + gap, s.pitch ?? 0)));
        const step = s.len / cols;
        const rows = Math.max(1, Math.min(s.pitch ? 1 : Math.min(s.maxRows ?? 2, 3), Math.floor(s.depth / (d + 0.008))));
        const layers = s.mode === 'stack' ? Math.max(1, Math.min(5, Math.floor(s.h / h))) : h < s.h * 0.4 && h < 0.16 ? Math.min(3, Math.floor(s.h / (h + 0.004))) : 1;
        for (let i = 0; i < cols; i++)
          for (let j = 0; j < rows; j++)
            for (let l = 0; l < layers; l++) {
              // sold-through gaps at the front
              if (j === 0 && l === layers - 1 && r.chance(0.03 + messy * 0.12)) continue;
              const jit = (0.004 + messy * 0.012) * Math.min(1, step / Math.max(w, 0.05));
              const pos = s.p.clone()
                .addScaledVector(right, -s.len / 2 + step * (i + 0.5) + r.range(-jit, jit))
                .addScaledVector(n, -(d / 2 + 0.006 + j * (d + 0.008)) + r.range(-jit, jit) * 0.5);
              pos.y += l * h;
              put(pos, s.rot + r.range(-1, 1) * (0.02 + messy * 0.18));
            }
      } else if (s.mode === 'hang') {
        const cols = Math.max(1, Math.floor((s.len + 0.04) / Math.max(w + 0.05, s.pitch ?? 0)));
        const rowsY = Math.max(1, Math.min(4, Math.floor((s.h + 0.06) / (h + 0.08))));
        const deep = s.pitch ? 1 : d < 0.06 ? 3 : d < 0.12 ? 2 : 1;
        const stepX = s.len / cols, stepY = s.h / rowsY;
        for (let i = 0; i < cols; i++)
          for (let j = 0; j < rowsY; j++)
            for (let q = 0; q < deep; q++) {
              const pos = s.p.clone()
                .addScaledVector(right, -s.len / 2 + stepX * (i + 0.5))
                .addScaledVector(n, d / 2 + 0.025 + q * (d + 0.01));
              pos.y += j * stepY + (stepY - h) * 0.7;
              put(pos, s.rot + r.range(-1, 1) * messy * 0.1);
            }
      } else if (s.mode === 'pile') {
        const area = s.len * s.depth;
        const count = Math.max(1, Math.min(36, Math.round((area / Math.max(w * d, s.pitch ? s.pitch * s.pitch : 0, 1e-4)) * 0.75)));
        const layers = h * 2.2 < s.h ? 2 : 1;
        for (let c = 0; c < count; c++)
          for (let l = 0; l < layers; l++) {
            if (l > 0 && r.chance(0.45)) continue;
            const pos = s.p.clone()
              .addScaledVector(right, r.range(-1, 1) * Math.max(0, s.len / 2 - w / 2))
              .addScaledVector(n, -s.depth / 2 + r.range(-1, 1) * Math.max(0, s.depth / 2 - d / 2));
            pos.y += l * h * 0.85;
            put(pos, messy > 0.7 ? r.range(0, Math.PI * 2) : s.rot + r.range(-1, 1) * (0.1 + messy * 0.6));
          }
      } else if (s.mode === 'single') {
        const pos = s.p.clone().addScaledVector(n, -s.depth / 2);
        put(pos, s.rot + r.range(-0.5, 0.5));
      } else if (s.mode === 'ceil') {
        const drop = r.range(0.15, Math.max(0.2, s.h - h));
        const pos = s.p.clone();
        pos.y -= drop + h;
        put(pos, r.range(0, Math.PI * 2));
        cords.push([s.p.clone(), pos.clone().setY(pos.y + h)]);
      }
      // whole blocks only: a block that would break the budget goes to packaging instead
      if (tri * slots.length > cap) {
        slots.length = before;
        cords.length = cordsBefore;
        rejected.push(s);
        continue;
      }
      if (slots.length > before) {
        const b = new THREE.Box3();
        for (let i = before; i < slots.length; i++) b.expandByPoint(slots[i].p).expandByPoint(slots[i].p.clone().setY(slots[i].p.y + h));
        b.expandByScalar(0.12);
        boxes.push(b);
      }
    }
    if (!slots.length) return rejected;
    const use = slots;
    this.triBudget -= tri * use.length;
    this.stats.products++;
    this.stats.slots += use.length;
    this.stats.tris += tri * use.length;
    const sand = this.instance(p.obj, use);
    for (const [a, b] of cords) {
      const len = a.y - b.y;
      const cm = new THREE.Mesh(new THREE.BoxGeometry(0.006, len, 0.006), M.black());
      cm.position.set(a.x, b.y + len / 2, a.z);
      cm.userData.owned = true;
      this.group.add(cm);
    }
    const e = p.e;
    if (!e) {
      // scanned product: no program to inspect, but its credit shows when you look at it
      for (const b of boxes) this.ports.push({ box: b, label: p.lib!.title, sub: `${LIB_NAME[p.lib!.source] ?? p.lib!.source} · ${p.lib!.licence}${p.lib!.author ? ` · by ${p.lib!.author}` : ''}`, target: 'inspect' });
      return rejected;
    }
    for (const b of boxes) this.portalFor(e, b);
    // then the original textured model, if this product has one and the budget allows
    loadOriginal(e.id, e.og, p.size, { prio: 50 + prio, texMax: 512 }).then((orig) => {
      if (!orig || !this.alive) return;
      // originals made of many separate meshes would multiply draw calls across every facing
      let meshes = 0, tris = 0;
      orig.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        meshes++;
        tris += (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute('position').count) / 3;
      });
      const extra = (tris - tri) * use.length;
      if (meshes > 12 || tris * use.length > 450_000 || this.triBudget - extra < 0) return;
      this.triBudget -= extra;
      this.stats.tris += extra;
      this.stats.originals++;
      for (const im of sand) this.group.remove(im);
      this.instance(orig, use);
    });
    return rejected;
  }

  private portalFor(e: RemoteEntry, b: THREE.Box3) {
    this.ports.push({
      box: b,
      label: e.title,
      sub: `${DATASET_LABEL[e.ds] ?? e.ds}${e.author ? ` · by ${e.author}` : ''} — E for details & its program`,
      target: 'inspect',
      inspect: e,
    });
  }

  /** every mesh under root becomes one InstancedMesh across all slots */
  private instance(root: THREE.Object3D, slots: Slot[]) {
    root.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    root.traverse((o) => (o as THREE.Mesh).isMesh && meshes.push(o as THREE.Mesh));
    const tmp = new THREE.Matrix4();
    const place = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const sc = new THREE.Vector3();
    const out: THREE.InstancedMesh[] = [];
    for (const mesh of meshes) {
      // instancing has no morph targets: give such meshes a plain copy of their geometry
      let geo = mesh.geometry;
      if (Object.keys(geo.morphAttributes ?? {}).length) {
        geo = geo.clone();
        geo.morphAttributes = {};
      }
      const im = new THREE.InstancedMesh(geo, mesh.material, slots.length);
      if (geo !== mesh.geometry) im.userData.owned = true;
      slots.forEach((sl, i) => {
        place.compose(sl.p, q.setFromAxisAngle(up, sl.rot), sc.setScalar(sl.s));
        tmp.multiplyMatrices(place, mesh.matrixWorld);
        im.setMatrixAt(i, tmp);
      });
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.receiveShadow = true;
      this.group.add(im);
      out.push(im);
    }
    return out;
  }

  colliders() {
    return this.cols;
  }
  portals() {
    return this.ports;
  }
  private tmp = new THREE.Vector3();
  update(_dt: number, player: THREE.Vector3) {
    for (const c of this.containers) {
      if (c.generated) continue;
      const d = this.tmp.set(player.x - c.center.x, 0, player.z - c.center.z);
      // near, and on the side you can see into
      if (d.length() < 5.5 && d.x * Math.sin(c.facing) + d.z * Math.cos(c.facing) > -0.2) c.generate();
    }
  }
  /** generate every container's contents now (lab, screenshots) */
  generateAll() {
    for (const c of this.containers) c.generate();
  }
  dispose() {
    this.alive = false;
    clearQueue();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.userData.owned) m.geometry.dispose();
    });
    for (const m of this.models) disposeModel(m.object);
  }
}

