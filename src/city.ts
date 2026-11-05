import * as THREE from 'three';
import { BIOMES, ROLE_BIOMES, type Biome } from './biomes';
import { Rng, hashN, streetName } from './rng';
import { pickModel, spawn, scaleTo, normScale, type ModelEntry } from './assets';
import { box, cyl, plane, mat, glow, worldUVBox, footprint, rectBox3, blob } from './build';
import { facade, roofTex, concreteTex, grassTex, roadTex, circuitTex, signTex, type FacadeStyle } from './textures';
import type { Env, Level, LevelDesc, Portal, Rect } from './level';
import { disposeTree, rect } from './level';

const CH = 56; // chunk size (one block plus half of each surrounding road)
const ROAD = 10;
const BLOCK = CH - ROAD; // 46
const LOTS = BLOCK - 6; // 40, inside the sidewalk
const R = 2; // chunk radius kept loaded

interface Chunk {
  group: THREE.Group;
  colliders: Rect[];
  portals: Portal[];
}

const INTERIOR_STYLES = ['house', 'house', 'office', 'shop', 'museum', 'workshop', 'library', 'apartment'];

const SHOP_WORDS = ['CAFE', 'BAKERY', 'BOOKS', 'TOYS', 'RADIO', 'MARKET', 'HOTEL', 'TOOLS', 'MUSEUM', 'ARCADE', 'TAILOR', 'GALLERY', 'DINER', 'PHARMACY'];

export function biomeForRole(role: string, rng: Rng): string {
  return rng.pick(ROLE_BIOMES[role] ?? Object.keys(BIOMES));
}

export function cityEnv(b: Biome): Env {
  return {
    skyTop: b.skyTop,
    skyBottom: b.skyBottom,
    stars: b.night,
    fog: b.fog,
    fogNear: b.fogNear,
    fogFar: b.fogFar,
    sun: b.sun,
    hemi: b.hemi,
    ambient: b.night ? 0.25 : 0.1,
    envIntensity: b.night ? 0.25 : 0.55,
    exposure: b.exposure,
  };
}

export class CityLevel implements Level {
  name: string;
  group = new THREE.Group();
  spawn = { pos: new THREE.Vector3(0, 0, 27.5), yaw: 0 };
  env: Env;
  biome: Biome;
  private chunks = new Map<string, Chunk>();
  private seed: number;
  private source?: ModelEntry;
  private snow?: THREE.Points;
  private lastKey = '';
  private nearPortals: Portal[] = [];
  private nearColliders: Rect[] = [];
  private cars: Car[] = [];
  private carRng: Rng;

  constructor(desc: Extract<LevelDesc, { kind: "city" }>) {
    this.seed = desc.seed;
    this.biome = BIOMES[desc.biome] ?? BIOMES.town;
    this.env = cityEnv(this.biome);
    this.name = desc.name;
    this.source = desc.source;
    this.carRng = new Rng(hashN(this.seed, 31337));
    if (this.biome.snow) this.makeSnow();
    // build the immediate surroundings right away
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) this.ensure(dx, dz);
    this.refreshNear(0, 0);
  }

  colliders(): Rect[] {
    return this.cars.length ? this.nearColliders.concat(this.cars.map((c) => c.rect)) : this.nearColliders;
  }

  portals(): Portal[] {
    return this.cars.length ? this.nearPortals.concat(this.cars.map((c) => c.portal)) : this.nearPortals;
  }

  /** Traffic: a handful of vehicles driving the road grid around the player. */
  private updateCars(dt: number, p: THREE.Vector3) {
    const want = this.biome.id === 'snow' ? 5 : 10;
    while (this.cars.length < want) {
      const c = this.makeCar(p);
      if (!c) break;
      this.cars.push(c);
    }
    for (const c of this.cars) {
      c.t += c.dir * c.speed * dt;
      const along = c.axis === 'x' ? p.x : p.z;
      const across = c.axis === 'x' ? p.z : p.x;
      if (Math.abs(c.t - along) > 110 || Math.abs(c.line - across) > 110) this.placeCar(c, p);
      const x = c.axis === 'x' ? c.t : c.line;
      const z = c.axis === 'x' ? c.line : c.t;
      c.obj.position.set(x, 0, z);
      const hx = (c.axis === 'x' ? c.size.long : c.size.wide) / 2;
      const hz = (c.axis === 'x' ? c.size.wide : c.size.long) / 2;
      c.rect.minX = x - hx; c.rect.maxX = x + hx; c.rect.minZ = z - hz; c.rect.maxZ = z + hz;
      c.portal.box.min.set(x - hx - 0.2, 0, z - hz - 0.2);
      c.portal.box.max.set(x + hx + 0.2, c.size.h, z + hz + 0.2);
    }
  }

  private makeCar(p: THREE.Vector3): Car | null {
    const e = pickModel('vehicle', this.carRng);
    if (!e) return null;
    const sp = spawn(e);
    const longX = sp.size.x >= sp.size.z;
    const car: Car = {
      obj: sp.obj,
      size: { long: Math.max(sp.size.x, sp.size.z), wide: Math.min(sp.size.x, sp.size.z), h: sp.size.y, longX },
      axis: 'x', dir: 1, line: 0, t: 0, speed: 8,
      rect: { minX: 0, minZ: 0, maxX: 0, maxZ: 0 },
      portal: { box: new THREE.Box3(), label: '', target: 'back' },
    };
    const size = car.size.long;
    car.portal = { box: new THREE.Box3(), label: `Shrink into “${e.title}”`, sub: `vehicle on the move · by ${e.author ?? 'unknown'}`, target: this.objectWorld(e, this.carRng.fork(1), size), shrink: size };
    this.placeCar(car, p);
    this.group.add(sp.obj);
    return car;
  }

  private placeCar(c: Car, p: THREE.Vector3) {
    const r = this.carRng;
    c.axis = r.chance(0.5) ? 'x' : 'z';
    c.dir = r.chance(0.5) ? 1 : -1;
    const across = c.axis === 'x' ? p.z : p.x;
    const along = c.axis === 'x' ? p.x : p.z;
    const k = Math.round(across / CH - 0.5) + r.int(-1, 1);
    c.line = (k + 0.5) * CH + c.dir * 1.7;
    c.t = along - c.dir * r.range(40, 100);
    c.speed = r.range(6, 13);
    // align the long axis with the direction of travel
    const base = c.axis === 'x' ? (c.size.longX ? 0 : Math.PI / 2) : c.size.longX ? Math.PI / 2 : 0;
    c.obj.rotation.y = base + (c.dir < 0 ? Math.PI : 0);
  }

  update(_dt: number, p: THREE.Vector3, time: number) {
    const cx = Math.round(p.x / CH);
    const cz = Math.round(p.z / CH);
    // stream: build at most two chunks per frame, nearest first
    let built = 0;
    for (let ring = 0; ring <= R && built < 2; ring++) {
      for (let dz = -ring; dz <= ring && built < 2; dz++) {
        for (let dx = -ring; dx <= ring && built < 2; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          if (this.ensure(cx + dx, cz + dz)) built++;
        }
      }
    }
    for (const [key, ch] of this.chunks) {
      const [x, z] = key.split(',').map(Number);
      if (Math.abs(x - cx) > R + 1 || Math.abs(z - cz) > R + 1) {
        this.group.remove(ch.group);
        disposeTree(ch.group);
        this.chunks.delete(key);
      }
    }
    const key = `${cx},${cz},${this.chunks.size}`;
    if (key !== this.lastKey) this.refreshNear(cx, cz);
    this.lastKey = key;
    this.updateCars(_dt, p);
    if (this.snow) {
      this.snow.position.set(p.x, 0, p.z);
      const pos = this.snow.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        let y = pos.getY(i) - _dt * (1.2 + (i % 5) * 0.2);
        if (y < 0) y += 30;
        pos.setY(i, y);
        pos.setX(i, pos.getX(i) + Math.sin(time * 0.8 + i) * _dt * 0.3);
      }
      pos.needsUpdate = true;
    }
  }

  dispose() {
    disposeTree(this.group);
    if (this.snow) this.snow.geometry.dispose();
  }

  private refreshNear(cx: number, cz: number) {
    this.nearPortals = [];
    this.nearColliders = [];
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const ch = this.chunks.get(`${cx + dx},${cz + dz}`);
        if (ch) {
          this.nearPortals.push(...ch.portals);
          this.nearColliders.push(...ch.colliders);
        }
      }
  }

  private makeSnow() {
    const n = 2500;
    const g = new THREE.BufferGeometry();
    const arr = new Float32Array(n * 3);
    const r = new Rng(this.seed);
    for (let i = 0; i < n; i++) {
      arr[i * 3] = r.range(-45, 45);
      arr[i * 3 + 1] = r.range(0, 30);
      arr[i * 3 + 2] = r.range(-45, 45);
    }
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    this.snow = new THREE.Points(g, new THREE.PointsMaterial({ color: '#ffffff', size: 0.12, transparent: true, opacity: 0.9 }));
    this.snow.frustumCulled = false;
    this.group.add(this.snow);
  }

  private ensure(cx: number, cz: number): boolean {
    const key = `${cx},${cz}`;
    if (this.chunks.has(key)) return false;
    const ch = this.buildChunk(cx, cz);
    ch.group.position.set(cx * CH, 0, cz * CH);
    // colliders/portals were produced in chunk-local space; move them to world space
    const ox = cx * CH, oz = cz * CH;
    for (const c of ch.colliders) { c.minX += ox; c.maxX += ox; c.minZ += oz; c.maxZ += oz; }
    for (const p of ch.portals) p.box.translate(new THREE.Vector3(ox, 0, oz));
    this.group.add(ch.group);
    this.chunks.set(key, ch);
    return true;
  }

  // ---------------------------------------------------------------- chunk

  private buildChunk(cx: number, cz: number): Chunk {
    const b = this.biome;
    const rng = new Rng(hashN(this.seed, cx, cz));
    const group = new THREE.Group();
    const colliders: Rect[] = [];
    const portals: Portal[] = [];
    const ctx: ChunkCtx = { b, rng, group, colliders, portals, seed: hashN(this.seed, cx, cz, 77), doors: [] };

    // ground: roads around, raised block slab with sidewalk
    const roadMap = b.circuit ? circuitTex() : roadTex(b.asphalt, b.line, CH, ROAD);
    const ground = plane(b.circuit ? mat('#ffffff', { map: roadMap, emissive: '#0a6a80', ei: 0.4 }) : mat('#ffffff', { map: roadMap, rough: 0.95 }), CH, CH);
    group.add(ground);
    const swTex = concreteTex(b.sidewalk, 64);
    const sw = box(mat('#ffffff', { map: swTex, rough: 0.9 }), BLOCK, 0.16, BLOCK, 0, 0, 0, false);
    group.add(sw);
    setRepeat(sw, BLOCK / 4);

    const isPlaza = cx === 0 && cz === 0;
    if (isPlaza) {
      this.plaza(ctx);
    } else {
      // lot layout
      const layout = rng.pick(['2x2', '2x2', '3x2', '2x1', '1x1']);
      const [nx, nz] = layout.split('x').map(Number);
      const lw = LOTS / nx;
      const ld = LOTS / nz;
      for (let iz = 0; iz < nz; iz++)
        for (let ix = 0; ix < nx; ix++) {
          const x0 = -LOTS / 2 + ix * lw;
          const z0 = -LOTS / 2 + iz * ld;
          const sides: Side[] = [];
          if (iz === 0) sides.push('N');
          if (iz === nz - 1) sides.push('S');
          if (ix === 0) sides.push('W');
          if (ix === nx - 1) sides.push('E');
          const lot = { x0, z0, w: lw, d: ld, sides, index: iz * nx + ix };
          const roll = rng.next();
          if (roll < b.parkChance) this.park(ctx, lot);
          else if (roll < b.parkChance + b.landmarkChance) this.landmark(ctx, lot);
          else this.building(ctx, lot);
        }
    }
    this.streetside(ctx, isPlaza);
    return { group, colliders, portals };
  }

  // ---------------------------------------------------------------- plaza

  private plaza(ctx: ChunkCtx) {
    const { b, rng, group, colliders, portals } = ctx;
    const pave = box(mat('#ffffff', { map: concreteTex(b.sidewalk, 32), rough: 0.85 }), LOTS + 4, 0.04, LOTS + 4, 0, 0.16, 0, false);
    setRepeat(pave, 6);
    group.add(pave);
    const y0 = 0.2;
    if (this.source) {
      // the object you climbed into, towering over the plaza: walk up to it to climb back out
      const e = this.source;
      const s = scaleTo(e, 24, 'max');
      const sp = spawn(e, s);
      sp.obj.position.set(0, y0, 0);
      group.add(sp.obj);
      const fp = rect(0, 0, sp.size.x, sp.size.z);
      colliders.push(fp);
      group.add(blob(sp.size.x, sp.size.z, 0, 0, y0 + 0.01));
      portals.push({ box: rectBox3(fp, 0, Math.max(3, sp.size.y), 0.3), label: `Climb back out of “${e.title}”`, sub: 'return to the bigger world', target: 'back' });
      // a ring of lights around it
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const r = Math.max(sp.size.x, sp.size.z) / 2 + 3;
        group.add(cyl(mat('#333333', { metal: 0.6, rough: 0.4 }), 0.08, 3, Math.cos(a) * r, y0, Math.sin(a) * r));
        group.add(glow(b.night ? '#ffd27a' : '#fff6dd', b.night ? 2.2 : 0.8, Math.cos(a) * r, y0 + 3.1, Math.sin(a) * r));
      }
    } else {
      // a monumental fountain basin with a sculpture
      const basin = mat('#cfc8bd', { rough: 0.6 });
      group.add(cyl(basin, 7, 0.7, 0, y0, 0));
      group.add(cyl(mat('#3f7fa8', { rough: 0.1, metal: 0.1, emissive: '#0b3550', ei: 0.4 }), 6.4, 0.72, 0, y0, 0));
      group.add(cyl(basin, 1.2, 2.2, 0, y0, 0));
      colliders.push(rect(0, 0, 13, 13));
      const e = pickModel(rng.pick(['craft', 'gear', 'instrument', 'toy', 'vehicle']), rng);
      if (e) {
        const sp = spawn(e, scaleTo(e, 6, 'max'));
        sp.obj.position.set(0, y0 + 2.2, 0);
        sp.obj.rotation.y = rng.range(0, Math.PI * 2);
        group.add(sp.obj);
        portals.push({ box: rectBox3(rect(0, 0, 13, 13), 0, 9), label: `Enter “${e.title}”`, sub: `a ${e.role} sculpture — there is a world inside`, target: this.objectWorld(e, rng, 6), shrink: 6 });
      }
    }
    // benches + trees around the edge
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const x = Math.cos(a) * 15, z = Math.sin(a) * 15;
      this.prop(ctx, 'plant', x, z, y0, rng.range(3, 5), true);
    }
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      this.prop(ctx, 'bench', Math.cos(a) * 16, Math.sin(a) * 16, y0, 0, false, -a + Math.PI / 2);
    }
  }

  // ---------------------------------------------------------------- lots

  private building(ctx: ChunkCtx, lot: Lot) {
    const { b, rng, group, colliders, portals } = ctx;
    const side = rng.pick(lot.sides.length ? lot.sides : (['S'] as Side[]));
    const margin = 1.2;
    let w = lot.w - margin * 2 - rng.range(0, 3);
    let d = lot.d - margin * 2 - rng.range(0, 4);
    w = Math.max(6, w);
    d = Math.max(6, d);
    // centre of the lot, pushed toward the front side
    let cx = lot.x0 + lot.w / 2;
    let cz = lot.z0 + lot.d / 2;
    const slack = 0.5;
    if (side === 'S') cz = lot.z0 + lot.d - margin - d / 2 + slack;
    if (side === 'N') cz = lot.z0 + margin + d / 2 - slack;
    if (side === 'E') cx = lot.x0 + lot.w - margin - w / 2 + slack;
    if (side === 'W') cx = lot.x0 + margin + w / 2 - slack;

    const [fmin, fmax] = b.floors;
    const centreBoost = this.biome.id === 'metropolis' ? 1 : 0;
    const floors = rng.int(fmin, fmax + centreBoost * 4);
    const fh = 3.2;
    const h = floors * fh + 0.5;
    const style = rng.pick(b.styles);
    const wall = rng.pick(b.walls);
    const fac = facade(style, wall, b.windowLit, rng.int(0, 2));
    const night = b.night;
    const fmat = new THREE.MeshStandardMaterial({
      map: fac.map,
      emissiveMap: fac.emissive,
      emissive: new THREE.Color(night ? '#ffffff' : '#000000'),
      emissiveIntensity: night ? 1.4 : 0,
      roughness: style === 'glass' ? 0.25 : 0.85,
      metalness: style === 'glass' ? 0.3 : 0,
    });
    const rmat = mat('#ffffff', { map: roofTex(rng.pick(b.roofs)), rough: 0.9 });
    const flatRoof = mat(rng.pick(b.roofs), { rough: 0.95 });
    const gable = floors <= 4 && rng.chance(b.gableChance);

    const bld = new THREE.Group();
    const geo = worldUVBox(w, h, d, 12, 12.8);
    const main = new THREE.Mesh(geo, [fmat, fmat, flatRoof, flatRoof, fmat, fmat]);
    main.userData.owned = true;
    main.position.y = h / 2;
    main.castShadow = main.receiveShadow = true;
    bld.add(main);
    // plinth band
    bld.add(box(mat(shadeHex(wall, 0.6), { rough: 0.9 }), w + 0.2, 0.7, d + 0.2));
    // cornice
    bld.add(box(mat(shadeHex(wall, 1.15), { rough: 0.8 }), w + 0.5, 0.35, d + 0.5, 0, h - 0.35, 0));

    if (gable) {
      const span = Math.min(w, d);
      const len = Math.max(w, d);
      const rh = span * rng.range(0.35, 0.55);
      const shape = new THREE.Shape();
      shape.moveTo(-span / 2 - 0.5, 0);
      shape.lineTo(span / 2 + 0.5, 0);
      shape.lineTo(0, rh);
      shape.closePath();
      const rg = new THREE.ExtrudeGeometry(shape, { depth: len + 0.8, bevelEnabled: false });
      rg.translate(0, 0, -(len + 0.8) / 2);
      // scale roof UVs to world metres
      const uv = rg.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / 4, uv.getY(i) / 4);
      const roof = new THREE.Mesh(rg, rmat);
      roof.userData.owned = true;
      roof.castShadow = roof.receiveShadow = true;
      roof.position.y = h;
      if (w > d) roof.rotation.y = Math.PI / 2;
      bld.add(roof);
      // chimney
      if (rng.chance(0.7)) bld.add(box(mat(shadeHex(wall, 0.7)), 0.8, rh + 1, 0.8, rng.range(-w / 4, w / 4), h, rng.range(-d / 4, d / 4)));
    } else {
      // parapet + rooftop clutter
      const pm = mat(shadeHex(wall, 0.85));
      bld.add(box(pm, w, 0.9, 0.25, 0, h, d / 2 - 0.125));
      bld.add(box(pm, w, 0.9, 0.25, 0, h, -d / 2 + 0.125));
      bld.add(box(pm, 0.25, 0.9, d, w / 2 - 0.125, h, 0));
      bld.add(box(pm, 0.25, 0.9, d, -w / 2 + 0.125, h, 0));
      const metal = mat('#9aa0a6', { metal: 0.6, rough: 0.4 });
      for (let i = rng.int(1, 4); i > 0; i--) bld.add(box(metal, rng.range(1, 2.4), rng.range(0.8, 1.6), rng.range(1, 2), rng.range(-w / 3, w / 3), h, rng.range(-d / 3, d / 3)));
      if (rng.chance(0.4)) {
        const tx = rng.range(-w / 4, w / 4), tz = rng.range(-d / 4, d / 4);
        const wood = mat('#6b4a32');
        for (const [lx, lz] of [[-0.8, -0.8], [0.8, -0.8], [-0.8, 0.8], [0.8, 0.8]]) bld.add(box(wood, 0.15, 2, 0.15, tx + lx, h, tz + lz));
        bld.add(cyl(wood, 1.2, 2.4, tx, h + 2, tz));
        bld.add(new THREE.Mesh(new THREE.ConeGeometry(1.3, 0.8, 16), wood).translateX(tx).translateY(h + 4.8).translateZ(tz));
      }
      if (rng.chance(0.3)) {
        bld.add(cyl(metal, 0.06, rng.range(4, 9), rng.range(-w / 4, w / 4), h, rng.range(-d / 4, d / 4)));
      }
      if (floors > 8 && rng.chance(0.6)) {
        // setback tower
        const w2 = w * rng.range(0.5, 0.75), d2 = d * rng.range(0.5, 0.75);
        const h2 = rng.int(3, 10) * fh;
        const g2 = worldUVBox(w2, h2, d2, 12, 12.8);
        const t2 = new THREE.Mesh(g2, [fmat, fmat, flatRoof, flatRoof, fmat, fmat]);
        t2.userData.owned = true;
        t2.position.y = h + h2 / 2;
        t2.castShadow = t2.receiveShadow = true;
        bld.add(t2);
      }
    }

    // neon trims
    if (b.neon) {
      const nc = rng.pick(b.neon);
      const nm = mat(nc, { emissive: nc, ei: 2.2 });
      for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) bld.add(box(nm, 0.12, h, 0.12, (sx * w) / 2, 0, (sz * d) / 2, false));
      bld.add(box(nm, w + 0.1, 0.12, 0.12, 0, h - 0.1, d / 2 + 0.05, false));
    }

    // front door (local +z is the front)
    const fw = side === 'E' || side === 'W' ? d : w;
    const fd = side === 'E' || side === 'W' ? w : d;
    if (side === 'E' || side === 'W') {
      // rebuild in local space where the front is +z: swap is handled by rotating the group
      main.geometry.dispose();
      const g3 = worldUVBox(fw, h, fd, 12, 12.8);
      main.geometry = g3;
      bld.children.forEach((c) => {
        if (c === main) return;
        // simple approach: rotate the decorative children by 90 degrees about the centre
        const x = c.position.x, z = c.position.z;
        c.position.x = z;
        c.position.z = -x;
        c.rotation.y += Math.PI / 2;
      });
    }
    const doorX = rng.range(-fw / 4, fw / 4);
    const door = new THREE.Group();
    const frame = mat(shadeHex(wall, 0.5), { rough: 0.6 });
    door.add(box(frame, 2.2, 3.0, 0.3, 0, 0, 0));
    door.add(box(mat(night ? '#ffcf87' : '#3b2a20', { emissive: night ? '#ffb85c' : undefined, ei: 0.9, rough: 0.5 }), 1.6, 2.6, 0.34, 0, 0, 0.01, false));
    door.add(box(mat('#d9c08a', { metal: 0.8, rough: 0.3 }), 0.08, 0.08, 0.1, 0.55, 1.2, 0.2, false));
    const aw = box(mat(rng.pick(['#8c2f39', '#2f5d8c', '#2f8c5a', '#c9a227', '#444444'])), 2.8, 0.12, 1.4, 0, 3.15, 0.7);
    aw.rotation.x = 0.25;
    door.add(aw);
    if (rng.chance(0.55)) {
      const word = rng.pick(SHOP_WORDS);
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 0.8), new THREE.MeshStandardMaterial({ map: signTex(word, '#1a1a1a', b.neon ? rng.pick(b.neon) : '#f1e3c0'), emissive: '#ffffff', emissiveMap: signTex(word, '#1a1a1a', b.neon ? rng.pick(b.neon) : '#f1e3c0'), emissiveIntensity: night ? 1.4 : 0.15 }));
      sign.userData.owned = true;
      sign.position.set(0, 3.9, 0.06);
      door.add(sign);
    }
    door.add(glow('#ffd9a0', night ? 1.6 : 0.6, 0, 3.5, 0.4, night ? 0.9 : 0.4));
    door.position.set(doorX, 0, fd / 2);
    bld.add(door);

    const rot = { S: 0, N: Math.PI, E: Math.PI / 2, W: -Math.PI / 2 }[side];
    bld.rotation.y = rot;
    bld.position.set(cx, 0.16, cz);
    group.add(bld);
    colliders.push(rect(cx, cz, w, d));
    // door in chunk space
    const dl = new THREE.Vector3(doorX, 0, fd / 2 + 0.3).applyAxisAngle(new THREE.Vector3(0, 1, 0), rot).add(new THREE.Vector3(cx, 0, cz));
    ctx.doors.push(dl);
    const r = new Rng(hashN(ctx.seed, lot.index, 5));
    const addr = streetName(r);
    const istyle = floors >= 7 ? r.pick(['office', 'apartment', 'office', 'museum']) : r.pick(INTERIOR_STYLES);
    portals.push({
      box: new THREE.Box3(dl.clone().add(new THREE.Vector3(-1.4, 0, -1.4)), dl.clone().add(new THREE.Vector3(1.4, 3.2, 1.4))),
      label: `Enter ${addr}`,
      sub: `${floors}-storey ${istyle}`,
      target: { kind: 'interior', seed: hashN(ctx.seed, lot.index, 99), name: addr, style: istyle, floor: 0, floors: Math.min(floors, 30), biome: b.id },
    });
  }

  private landmark(ctx: ChunkCtx, lot: Lot) {
    const { rng, group, colliders, portals } = ctx;
    const e = pickModel('building', rng);
    if (!e) return this.building(ctx, lot);
    const fit = Math.min(lot.w, lot.d) - 3;
    const horiz = Math.max(e.size[0], e.size[2]);
    let s = fit / horiz;
    if (e.size[1] * s > 40) s = 40 / e.size[1];
    const sp = spawn(e, s);
    const cx = lot.x0 + lot.w / 2, cz = lot.z0 + lot.d / 2;
    const rot = rng.int(0, 3) * (Math.PI / 2);
    sp.obj.rotation.y = rot;
    sp.obj.position.set(cx, 0.16, cz);
    group.add(sp.obj);
    const fp = footprint(sp.size.x, sp.size.z, rot, cx, cz);
    colliders.push(fp);
    group.add(blob(fp.maxX - fp.minX, fp.maxZ - fp.minZ, cx, cz, 0.18));
    const r = new Rng(hashN(ctx.seed, lot.index, 7));
    const style = r.pick(['museum', 'house', 'shop', 'library', 'workshop']);
    portals.push({
      box: rectBox3(fp, 0, Math.max(3, sp.size.y), 0.6),
      label: `Enter “${e.title}”`,
      sub: `sand3d landmark · ${style}`,
      target: { kind: 'interior', seed: hashN(ctx.seed, lot.index, 101), name: e.title, style, floor: 0, floors: r.int(1, 4), biome: this.biome.id },
    });
    // a little garden around it
    for (let i = 0; i < 2; i++) {
      const px = lot.x0 + 1.2 + rng.next() * (lot.w - 2.4);
      const pz = lot.z0 + (rng.chance(0.5) ? 1.2 : lot.d - 1.2);
      this.prop(ctx, 'plant', px, pz, 0.16, rng.range(1.2, 2.4), false);
    }
  }

  private park(ctx: ChunkCtx, lot: Lot) {
    const { b, rng, group } = ctx;
    const g = box(mat('#ffffff', { map: grassTex(b.grass), rough: 1 }), lot.w - 1, 0.1, lot.d - 1, lot.x0 + lot.w / 2, 0.16, lot.z0 + lot.d / 2, false);
    setRepeat(g, Math.max(lot.w, lot.d) / 4);
    group.add(g);
    const cx = lot.x0 + lot.w / 2, cz = lot.z0 + lot.d / 2;
    const y = 0.26;
    // a path cross
    const pathM = mat('#ffffff', { map: concreteTex(b.sidewalk, 128), rough: 0.9 });
    group.add(box(pathM, lot.w - 1, 0.02, 2, cx, y - 0.01, cz, false));
    group.add(box(pathM, 2, 0.02, lot.d - 1, cx, y - 0.01, cz, false));
    // centrepiece: a streetprop (fountain/statue) or a sculpture of some craft
    const role = rng.pick(['streetprop', 'streetprop', 'craft', 'vehicle', 'gear', 'machine']);
    this.prop(ctx, role, cx, cz, y, role === 'streetprop' ? 0 : rng.range(3, 6), true, rng.range(0, 6.28), true);
    // trees
    const n = rng.int(4, 9);
    for (let i = 0; i < n; i++) {
      const tx = lot.x0 + 2 + rng.next() * (lot.w - 4);
      const tz = lot.z0 + 2 + rng.next() * (lot.d - 4);
      if (Math.abs(tx - cx) < 3.5 || Math.abs(tz - cz) < 3.5) continue;
      this.prop(ctx, 'plant', tx, tz, y, rng.range(2.5, 6), true);
    }
    // benches along the path
    for (let i = 0; i < 2; i++) {
      const off = (i ? 1 : -1) * (lot.w / 4);
      this.prop(ctx, 'bench', cx + off, cz + 2.2, y, 0, false, Math.PI);
    }
  }

  // ---------------------------------------------------------------- street furniture

  private streetside(ctx: ChunkCtx, plaza: boolean) {
    const { b, rng, group } = ctx;
    const edge = BLOCK / 2 - 1.0; // lamp line, near the kerb
    const sideDefs: { axis: 'x' | 'z'; sign: number; rot: number }[] = [
      { axis: 'x', sign: 1, rot: 0 },
      { axis: 'x', sign: -1, rot: Math.PI },
      { axis: 'z', sign: 1, rot: Math.PI / 2 },
      { axis: 'z', sign: -1, rot: -Math.PI / 2 },
    ];
    for (const s of sideDefs) {
      for (let t = -18; t <= 18; t += 12) {
        const x = s.axis === 'x' ? t : s.sign * edge;
        const z = s.axis === 'x' ? s.sign * edge : t;
        if (ctx.doors.some((d) => Math.hypot(d.x - x, d.z - z) < 3)) continue;
        const lamp = this.prop(ctx, 'streetlamp', x, z, 0.16, 0, false, s.rot + Math.PI);
        if (lamp && (b.night || b.id === 'snow')) {
          group.add(glow(b.neon ? rng.pick(b.neon) : '#ffd58a', 3.2, x, lamp.size.y * 0.95 + 0.16, z, 0.85));
        }
      }
      // extra clutter between lamps
      for (let t = -12; t <= 12; t += 12) {
        if (!rng.chance(0.55)) continue;
        const off = t + rng.range(-3, 3);
        const x = s.axis === 'x' ? off : s.sign * (edge - 0.3);
        const z = s.axis === 'x' ? s.sign * (edge - 0.3) : off;
        if (ctx.doors.some((d) => Math.hypot(d.x - x, d.z - z) < 3)) continue;
        const role = rng.pick(['streetprop', 'plant', 'bench', 'streetprop', 'plant']);
        this.prop(ctx, role, x, z, 0.16, role === 'plant' ? rng.range(2.5, 4.5) : 0, role !== 'bench', s.rot + Math.PI, role === 'streetprop');
      }
      // parked vehicles on the road
      if (plaza) continue;
      for (let t = -14; t <= 14; t += 9.5) {
        if (!rng.chance(0.4)) continue;
        const e = pickModel('vehicle', rng);
        if (!e) continue;
        const sp = spawn(e);
        const along = s.axis === 'x';
        // align the vehicle's long axis with the road
        const longX = sp.size.x >= sp.size.z;
        let rot = along ? (longX ? 0 : Math.PI / 2) : longX ? Math.PI / 2 : 0;
        if (rng.chance(0.5)) rot += Math.PI;
        const lane = BLOCK / 2 + 1.2;
        const x = along ? t : s.sign * lane;
        const z = along ? s.sign * lane : t;
        sp.obj.rotation.y = rot;
        sp.obj.position.set(x, 0, z);
        group.add(sp.obj);
        const fp = footprint(sp.size.x, sp.size.z, rot, x, z);
        ctx.colliders.push(fp);
        group.add(blob(fp.maxX - fp.minX, fp.maxZ - fp.minZ, x, z));
        ctx.portals.push(this.objectPortal(sp.entry, rectBox3(fp, 0, sp.size.y, 0.2), Math.max(sp.size.x, sp.size.z)));
      }
    }
  }

  /** Place one model; height>0 forces a height (trees in parks etc.). */
  private prop(ctx: ChunkCtx, role: string, x: number, z: number, y: number, height: number, randomRot: boolean, rot = 0, portal = false) {
    const e = pickModel(role, ctx.rng);
    if (!e) return null;
    const s = height > 0 ? scaleTo(e, height, 'h') : normScale(e);
    const sp = spawn(e, s);
    sp.obj.position.set(x, y, z);
    sp.obj.rotation.y = randomRot ? ctx.rng.range(0, Math.PI * 2) : rot;
    ctx.group.add(sp.obj);
    const r = Math.min(sp.size.x, sp.size.z) * 0.4;
    const fp = rect(x, z, Math.max(0.3, r * 2), Math.max(0.3, r * 2));
    ctx.colliders.push(fp);
    if (role !== 'streetlamp') ctx.group.add(blob(sp.size.x, sp.size.z, x, z, y + 0.01));
    if (portal || role !== 'streetlamp') {
      const big = Math.max(sp.size.x, sp.size.y, sp.size.z);
      const bx = new THREE.Box3(new THREE.Vector3(x - sp.size.x / 2, y, z - sp.size.z / 2), new THREE.Vector3(x + sp.size.x / 2, y + sp.size.y, z + sp.size.z / 2));
      bx.expandByScalar(0.15);
      ctx.portals.push(this.objectPortal(e, bx, big));
    }
    return sp;
  }

  private objectPortal(e: ModelEntry, bx: THREE.Box3, size: number): Portal {
    const rng = new Rng(hashN(this.seed, bx.min.x * 100, bx.min.z * 100));
    return { box: bx, label: `Shrink into “${e.title}”`, sub: `${e.role} · by ${e.author ?? 'unknown'}`, target: this.objectWorld(e, rng, size), shrink: size };
  }

  objectWorld(e: ModelEntry, rng: Rng, size: number): LevelDesc {
    const biome = biomeForRole(e.role, rng);
    return { kind: 'city', seed: hashN(rng.int(0, 1e9), this.seed), biome, name: `Inside “${e.title}”`, source: e, sourceScale: size };
  }
}

type Side = 'N' | 'S' | 'E' | 'W';
interface Car {
  obj: THREE.Group;
  size: { long: number; wide: number; h: number; longX: boolean };
  axis: 'x' | 'z';
  dir: number;
  line: number;
  t: number;
  speed: number;
  rect: Rect;
  portal: Portal;
}
interface Lot {
  x0: number;
  z0: number;
  w: number;
  d: number;
  sides: Side[];
  index: number;
}
interface ChunkCtx {
  b: Biome;
  rng: Rng;
  group: THREE.Group;
  colliders: Rect[];
  portals: Portal[];
  seed: number;
  doors: THREE.Vector3[];
}

function setRepeat(m: THREE.Mesh, n: number) {
  const mt = m.material as THREE.MeshStandardMaterial;
  if (mt.map) mt.map.repeat.set(n, n);
}

function shadeHex(hex: string, f: number): string {
  const c = new THREE.Color(hex).multiplyScalar(f);
  return `#${c.getHexString()}`;
}

export type { FacadeStyle };
