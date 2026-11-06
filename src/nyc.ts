import * as THREE from 'three';
import { AX, SZ, BX, BZ, LX, LZ, CURB, RX, RZ, avenueName, streetName, bake, unitBox, unitCyl, unitSphere, B, SIG, lightFor, type Side } from './nyc/common';
import { signalPole, nameSign, lampPost, tree, hydrant, subway, newsBoxes, steamStack, streetExtras } from './nyc/streetprops';
import { getNight, onTimeChange } from './lighting';
import { groundBase, groundDetails, GM } from './nyc/ground';
import { carMesh, Traffic } from './nyc/vehicles';
import { busStop, noParking } from './nyc/vehicleBusStop';
import { Pedestrians } from './nyc/people';
import { CityVis } from './nyc/occlusion'; // [vis] chunk visibility / occlusion / HLOD (WP2)
export { avenueName, streetName };
export { SHOPS } from './nyc/buildings';
export { setNight } from './nyc/buildings';
import { building, makeCtx, finishBuildings, setBlockDetail, setNight as setBuildingNight, type BCtx, type Hull } from './nyc/buildings';
// lighting.ts drives the time of day: lit rooms, shop interiors and signs follow it
onTimeChange((_t, n) => setBuildingNight(n));
setBuildingNight(getNight());
import { Rng, hashN } from './rng';
import { pickModel, spawn, normScale, type ModelEntry } from './assets';
import { mat, glow } from './build';
import type { Env, Level, LevelDesc, Portal, Rect } from './level';
import { disposeTree, rect } from './level';
import { BIOMES } from './biomes';
// [districts] neighbourhoods: building/shop mix, open spaces, showcase objects (src/nyc/district*.ts)
import { districtAt, SPAWN, spawnView } from './nyc/districts';
import { nycMinimapSource } from './nyc/minimap-nyc'; // [minimap]
import { registerMinimapSource } from './minimap';
import { openChunk, customBlock, aveType, rowType, floorsFor, districtStyle, districtExtras, updateDistricts } from './nyc/district-build';

// ---------------------------------------------------------------- static geometry baking

interface Chunk {
  group: THREE.Group;
  colliders: Rect[];
  portals: Portal[];
  /** building outlines in world coordinates (occlusion / HLOD) */
  hulls?: Hull[];
}

export class NycLevel implements Level {
  name: string;
  group = new THREE.Group();
  spawn = { pos: new THREE.Vector3(SPAWN.x, 0, SPAWN.z), yaw: SPAWN.yaw }; // [districts] the 5 Av view north (districts.ts)
  env: Env;
  private chunks = new Map<string, Chunk>();
  private seed: number;
  private nearPortals: Portal[] = [];
  private nearCols: Rect[] = [];
  private lastKey = '';
  private traffic: Traffic;
  private peds: Pedestrians;
  private steam: THREE.Sprite[] = [];
  /** [vis] which chunks draw real geometry, an HLOD proxy, or only a shadow proxy */
  readonly vis = new CityVis();

  constructor(desc: Extract<LevelDesc, { kind: 'nyc' }>) {
    this.seed = desc.seed;
    this.name = desc.name;
    const b = BIOMES.metropolis;
    this.env = {
      skyTop: '#5d8cc4', skyBottom: '#e9dcc8', stars: false, fog: '#aab6c2', fogNear: 110, fogFar: 420,
      sun: { color: '#ffd9a8', intensity: 4.2, elev: 30, azim: 235 }, hemi: { sky: '#cfdcec', ground: '#5a5046', intensity: 0.9 },
      ambient: 0.05, envIntensity: 0.55, exposure: 0.62, physicalSky: true,
    };
    void b;
    this.vis.attach(this.group); // [vis]
    // the first ring at once (?r=0: just the spawn block, so fast dev/QA boots build one chunk, not nine)
    for (let dz = -Math.min(1, RZ); dz <= Math.min(1, RZ); dz++) for (let dx = -Math.min(1, RX); dx <= Math.min(1, RX); dx++) this.ensure(dx, dz);
    this.refresh(0, 0);
    this.traffic = new Traffic(this.group, this.seed);
    this.peds = new Pedestrians(this.group, this.seed);
  }

  /** building outlines of every streamed chunk, world coordinates, keyed by chunk "cx,cz" */
  hulls(): Map<string, Hull[]> {
    const m = new Map<string, Hull[]>();
    for (const [k, ch] of this.chunks) m.set(k, ch.hulls ?? []);
    return m;
  }
  colliders() {
    return this.nearCols.concat(this.traffic.rects());
  }
  portals() {
    return this.nearPortals.concat(this.traffic.portals);
  }

  update(dt: number, p: THREE.Vector3, time: number) {
    const cx = Math.round(p.x / AX), cz = Math.round(p.z / SZ);
    this.lastCenter = [cx, cz];
    // [vis] time-sliced streaming: the nearest missing chunk is built a few ms per frame (a
    // generator yielding between buildings), and at most one far chunk is unloaded per frame
    if (!this.pending) {
      search: for (let ring = 0; ring <= Math.max(RX, RZ); ring++)
        for (let dz = -Math.min(ring, RZ); dz <= Math.min(ring, RZ); dz++)
          for (let dx = -Math.min(ring, RX); dx <= Math.min(ring, RX); dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring || this.chunks.has(`${cx + dx},${cz + dz}`)) continue;
            this.pending = { cx: cx + dx, cz: cz + dz, it: this.blockSteps(cx + dx, cz + dz) };
            break search;
          }
    }
    if (this.pending) {
      const t0 = performance.now();
      for (;;) {
        const r = this.pending.it.next();
        if (r.done) {
          this.place(this.pending.cx, this.pending.cz, r.value);
          this.pending = null;
          break;
        }
        if (performance.now() - t0 > NycLevel.BUILD_BUDGET_MS) break;
      }
    }
    for (const [k, ch] of this.chunks) {
      const [x, z] = k.split(',').map(Number);
      if (Math.abs(x - cx) > RX + 1 || Math.abs(z - cz) > RZ + 1) {
        this.vis.remove(x, z); // [vis]
        this.group.remove(ch.group);
        disposeTree(ch.group);
        this.chunks.delete(k);
        break; // [vis] one unload per frame
      }
    }
    // LOD: small details (brackets, balusters, sashes, AC units) only on nearby blocks
    for (const [k, ch] of this.chunks) {
      const [x, z] = k.split(',').map(Number);
      setBlockDetail(ch.group, Math.abs(x - cx) <= 1 && Math.abs(z - cz) <= 1);
    }
    this.vis.update(new THREE.Vector3(p.x, p.y + 1.6, p.z), cx, cz, RX, RZ); // [vis]
    const key = `${cx},${cz},${this.chunks.size}`;
    if (key !== this.lastKey) this.refresh(cx, cz);
    this.lastKey = key;
    // signals
    for (const [axis, r, y, g] of [['z', SIG.aveR, SIG.aveY, SIG.aveG], ['x', SIG.stR, SIG.stY, SIG.stG]] as const) {
      const l = lightFor(axis, time);
      r.emissiveIntensity = l === 'r' ? 3 : 0.05;
      y.emissiveIntensity = l === 'y' ? 3 : 0.05;
      g.emissiveIntensity = l === 'g' ? 3 : 0.05;
    }
    this.traffic.update(dt, p, time);
    this.peds.update(dt, p, time, this.nearCols);
    updateDistricts(p, time); // [districts] stream showcase objects near the player
    for (const s of this.steam) {
      const ph = ((time * 0.35 + s.userData.ph) % 1);
      s.position.y = s.userData.y + ph * 5;
      s.scale.setScalar(1 + ph * 3);
      (s.material as THREE.SpriteMaterial).opacity = 0.45 * (1 - ph);
    }
  }

  dispose() {
    disposeTree(this.group);
  }

  private refresh(cx: number, cz: number) {
    this.nearPortals = [];
    this.nearCols = [];
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const ch = this.chunks.get(`${cx + dx},${cz + dz}`);
        if (ch) {
          this.nearPortals.push(...ch.portals);
          this.nearCols.push(...ch.colliders);
        }
      }
  }

  private ensure(cx: number, cz: number) {
    const k = `${cx},${cz}`;
    if (this.chunks.has(k)) return false;
    this.place(cx, cz, this.block(cx, cz));
    return true;
  }

  /** [vis] a chunk being built across frames (see update) */
  private pending: { cx: number; cz: number; it: Generator<void, Chunk> } | null = null;
  /** [vis] true while a chunk is being built across frames */
  get streaming() {
    if (this.pending) return true;
    const [cx, cz] = this.lastCenter;
    for (let dz = -RZ; dz <= RZ; dz++) for (let dx = -RX; dx <= RX; dx++) if (!this.chunks.has(`${cx + dx},${cz + dz}`)) return true;
    return false;
  }
  private lastCenter: [number, number] = [0, 0];
  /** [vis] per-frame budget for chunk building (ms) */
  static BUILD_BUDGET_MS = 4;

  /** shift a built chunk to its grid position and add it */
  private place(cx: number, cz: number, ch: Chunk) {
    const k = `${cx},${cz}`;
    const ox = cx * AX, oz = cz * SZ;
    ch.group.position.set(ox, 0, oz);
    for (const c of ch.colliders) { c.minX += ox; c.maxX += ox; c.minZ += oz; c.maxZ += oz; }
    for (const hl of ch.hulls ?? []) for (const rr of [hl.rect, ...(hl.tiers ?? []).map((t) => t.rect)]) { rr.minX += ox; rr.maxX += ox; rr.minZ += oz; rr.maxZ += oz; }
    for (const p of ch.portals) {
      p.box.translate(new THREE.Vector3(ox, 0, oz));
      p.returnPos?.add(new THREE.Vector3(ox, 0, oz));
      if (p.door) { p.door.pos.add(new THREE.Vector3(ox, 0, oz)); p.door.hole?.translate(new THREE.Vector3(ox, 0, oz)); } // seamless.ts
    }
    this.group.add(ch.group);
    this.chunks.set(k, ch);
    this.vis.add(cx, cz, ch.group, ch.hulls); // [vis]
    nycMinimapSource.addChunk(cx, cz, ch.hulls); // [minimap] building footprints for the map tiles
  }

  // ------------------------------------------------------------ one block

  /** one block, built in one go (constructor, tests) */
  private block(cx: number, cz: number): Chunk {
    const it = this.blockSteps(cx, cz);
    for (;;) {
      const r = it.next();
      if (r.done) return r.value;
    }
  }

  /** [vis] the block build as steps: yields between buildings so update() can spread it over frames */
  private *blockSteps(cx: number, cz: number): Generator<void, Chunk> {
    const rng = new Rng(hashN(this.seed, cx, cz));
    const group = new THREE.Group();
    const stat = new THREE.Group(); // merged at the end
    const colliders: Rect[] = [];
    const portals: Portal[] = [];
    // [districts] the neighbourhood: open spaces build themselves; elsewhere it sets the character
    const D = districtAt(cx, cz);
    if (D.open) return openChunk(D, cx, cz, hashN(this.seed, cx, cz, 5), GM.road());
    const tower = Math.min(1, Math.max(0, D.tower + 0.2 * Math.sin(cx * 0.9 + this.seed * 0.001) * Math.cos(cz * 0.37 + 1.3)));
    const village = D.village;

    // road, sidewalk, curbs, ramps and markings (nyc/ground.ts)
    // Belgian block on the old industrial / loft streets and some brownstone blocks
    const loft = D.kind === 'industrial' || D.kind === 'canal' || D.kind === 'bowery' || D.kind === 'garment';
    const cobble = (D.kind === 'industrial' && hashN(this.seed, cx, cz, 9) % 2 === 0) || ((D.kind === 'canal' || village) && hashN(this.seed, cx, cz, 9) % 4 === 0);
    groundBase({ group, stat, cx, cz, village: loft, cobble });
    yield; // [vis]
    // the backyard core of the block: kept below the pavement plane so it never stands in front of
    // a real shop interior previewed behind its glass (seamless.ts)
    const core = B(stat, mat('#5a564f'), LX * 2 - 1, 0.1, LZ * 2 - 1, 0, 0, 0, false);

    const ctx: BCtx = makeCtx(rng, group, stat, cx, cz, hashN(this.seed, cx, cz, 5));
    ctx.colliders = colliders;
    ctx.portals = portals;
    const plan = customBlock(ctx, D); // [districts] lots, yards, plazas take some frontages
    if (plan.core === false) stat.remove(core); // [districts] open lots: no backyard box in the way

    // avenue frontage: both ends of the block
    for (const end of [-1, 1]) {
      if (!plan.ave[end < 0 ? 0 : 1]) continue; // [districts]
      const x0 = end < 0 ? -LX : LX - 20;
      const x1 = end < 0 ? -LX + 20 : LX;
      const side: Side = end < 0 ? 'W' : 'E';
      const big = tower > 0.62 && rng.chance(0.7);
      if (big) {
        building(ctx, { minX: x0, maxX: x1, minZ: -LZ, maxZ: LZ }, side, 'tower', rng.int(22, 48), true, [true, true], districtStyle(D, rng, cx, cz)); yield; // [vis]
      } else {
        const n = rng.int(2, 3);
        const cuts = [-LZ];
        for (let i = 1; i < n; i++) cuts.push(-LZ + (i * 2 * LZ) / n + rng.range(-3, 3));
        cuts.push(LZ);
        for (let i = 0; i < n; i++) {
          const type = aveType(D, rng); // [districts]
          const floors = floorsFor(D, type === 'prewar' ? rng.int(9, 18) : type === 'midrise' ? rng.int(6, 12) : type === 'brownstone' ? rng.int(3, 5) : rng.int(5, 6));
          building(ctx, { minX: x0, maxX: x1, minZ: cuts[i], maxZ: cuts[i + 1] }, side, type, floors, true, [i === 0, i === n - 1], districtStyle(D, rng, cx, cz)); yield; // [vis]
        }
      }
    }
    // mid-block rows facing the streets
    for (const row of [-1, 1]) {
      if (!plan.rows[row < 0 ? 0 : 1]) continue; // [districts]
      const side: Side = row < 0 ? 'N' : 'S';
      let x = -LX + 20;
      while (x < LX - 20 - 3) {
        const type = rowType(D, rng); // [districts]
        let w = type === 'brownstone' ? rng.range(5.5, 7) : type === 'castiron' ? rng.range(9, 14) : rng.range(7, 10);
        if (x + w > LX - 20 - 3) w = LX - 20 - x;
        const depth = rng.range(14, 19);
        const r: Rect = row < 0 ? { minX: x, maxX: x + w, minZ: -LZ, maxZ: -LZ + depth } : { minX: x, maxX: x + w, minZ: LZ - depth, maxZ: LZ };
        const floors = floorsFor(D, type === 'brownstone' ? rng.int(3, 5) : type === 'tenement' ? rng.int(4, 6) : type === 'castiron' ? rng.int(5, 7) : type === 'prewar' ? rng.int(9, 14) : rng.int(7, 12));
        const store = type !== 'brownstone' && rng.chance(Math.min(1, (type === 'tenement' ? 0.6 : 0.75) * D.stores));
        building(ctx, r, side, type, floors, store, [false, false], districtStyle(D, rng, cx, cz)); yield; // [vis]
        x += w;
      }
    }
    this.street(ctx, village, tower);
    yield; // [vis]
    districtExtras(ctx, D); // [districts] sidewalk displays, district props
    groundDetails({ group, stat, cx, cz, village: loft, doors: ctx.doors, seed: this.seed });
    yield; // [vis]

    // buildings: windows, shop glass, lettering, instanced small parts (pulled out of stat first)
    finishBuildings(ctx);
    yield; // [vis]
    // merge everything static into a few meshes
    const baked = bake(stat);
    group.add(baked);
    // dispose the per-building geometries that were merged
    stat.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry !== unitBox && m.geometry !== unitCyl && m.geometry !== unitSphere) m.geometry.dispose();
    });
    return { group, colliders, portals, hulls: ctx.hulls };
  }

  // ------------------------------------------------------------ street furniture

  private street(ctx: BCtx, village: boolean, tower: number) {
    const { rng, stat, group, colliders } = ctx;
    const edgeX = BX - 0.7, edgeZ = BZ - 0.7;
    const near = (x: number, z: number, d = 2.2) => ctx.doors.some((p) => Math.hypot(p.x - x, p.z - z) < d);

    // corners: traffic signals, name signs, sometimes a subway entrance
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const x = sx * (BX - 0.9), z = sz * (BZ - 0.9);
      signalPole(stat, x, z, sx, sz);
      colliders.push(rect(x, z, 0.5, 0.5));
      const ave = avenueName(ctx.cx + (sx > 0 ? 0 : -1));
      const st = streetName(ctx.cz + (sz > 0 ? 0 : -1));
      stat.add(nameSign(st, x, CURB + 6.32, z, 0));
      stat.add(nameSign(ave, x, CURB + 6.6, z, Math.PI / 2));
    }
    if (rng.chance(0.35)) {
      const sx = rng.chance(0.5) ? -1 : 1, sz = rng.chance(0.5) ? -1 : 1;
      // not in front of a door (npm run qa: tests/nyc.test.ts)
      if (!near(sx * (BX - 2.2), sz * (BZ - 9), 4.5)) {
        subway(stat, group, sx * (BX - 2.2), sz * (BZ - 9), ctx.cz, rng);
        colliders.push(rect(sx * (BX - 2.2), sz * (BZ - 9), 2.2, 5.4));
      }
    }

    // along the four kerbs
    const runs: { axis: 'x' | 'z'; c: number; from: number; to: number; ave: boolean }[] = [
      { axis: 'x', c: -edgeZ, from: -BX + 4, to: BX - 4, ave: false },
      { axis: 'x', c: edgeZ, from: -BX + 4, to: BX - 4, ave: false },
      { axis: 'z', c: -edgeX, from: -BZ + 4, to: BZ - 4, ave: true },
      { axis: 'z', c: edgeX, from: -BZ + 4, to: BZ - 4, ave: true },
    ];
    for (const run of runs) {
      const P = (t: number) => (run.axis === 'x' ? [t, run.c] : [run.c, t]) as [number, number];
      // street lights
      for (let t = run.from + 3; t < run.to; t += 26) {
        const [x, z] = P(t);
        if (near(x, z)) continue;
        lampPost(stat, group, x, z, run.axis, run.c > 0 ? 1 : -1, village ? 'crook' : 'cobra');
        colliders.push(rect(x, z, 0.4, 0.4));
      }
      // street trees
      if (!run.ave && (village || tower < 0.6)) {
        for (let t = run.from + 9; t < run.to - 3; t += rng.range(8, 11)) {
          const [x, z] = P(t);
          if (near(x, z, 2.6)) continue;
          tree(stat, x, z, rng, group, run.axis);
          colliders.push(rect(x, z, 0.5, 0.5));
        }
      }
      // hydrant, newspaper boxes, steam pipe
      {
        const [x, z] = P(rng.range(run.from + 4, run.to - 4));
        if (!near(x, z)) {
          hydrant(stat, x, z);
          colliders.push(rect(x, z, 0.4, 0.4));
        }
      }
      if (rng.chance(0.4)) {
        const [x, z] = P(rng.range(run.from + 2, run.to - 2));
        if (!near(x, z)) {
          newsBoxes(stat, x, z, run.axis, rng, -Math.sign(run.c));
          colliders.push(run.axis === 'x' ? rect(x, z, 2.2, 0.5) : rect(x, z, 0.5, 2.2));
        }
      }
      if (run.ave && rng.chance(0.35)) {
        // steam stack in the avenue
        const [x, z] = P(rng.range(run.from, run.to));
        const ax = run.axis === 'z' ? x + Math.sign(x) * 3.5 : x;
        const az = run.axis === 'x' ? z + Math.sign(z) * 3 : z;
        steamStack(stat, ax, az, Math.sign(x) > 0 ? Math.PI : 0);
        colliders.push(rect(ax, az, 1.1, 1.1));
        for (let k = 0; k < 3; k++) {
          const s = glow('#ffffff', 1.5, ax, 3.8, az, 0.4);
          (s.material as THREE.SpriteMaterial).blending = THREE.NormalBlending;
          s.material = (s.material as THREE.SpriteMaterial).clone();
          s.userData.ph = k / 3;
          s.userData.y = 3.8;
          group.add(s);
          this.steam.push(s);
        }
      }
      // parked cars on streets (and sand3d vehicles you can shrink into)
      const lane = run.axis === 'x' ? (BZ + 1.15) * Math.sign(run.c) : (BX + 1.15) * Math.sign(run.c);
      for (let t = run.from + 4; t < run.to - 4; t += rng.range(6.5, 9)) {
        if (!rng.chance(run.ave ? 0.85 : 0.8)) continue; // Manhattan kerbs are nearly full
        const x = run.axis === 'x' ? t : lane;
        const z = run.axis === 'x' ? lane : t;
        if (noParking(ctx.cx, ctx.cz, x, z)) continue; // the bus stop at the spawn (vehicleBusStop.ts)
        if (rng.chance(0.18)) {
          const e = pickModel('vehicle', rng);
          if (e && Math.max(e.size[0], e.size[2]) * normScale(e) < 7) {
            this.parkedModel(ctx, e, x, z, run.axis);
            t += 2;
            continue;
          }
        }
        const car = carMesh(rng.chance(0.15) ? 'cab' : 'sedan', rng);
        car.position.set(x, 0, z);
        car.rotation.y = (run.axis === 'x' ? Math.PI / 2 : 0) + (rng.chance(0.5) ? Math.PI : 0);
        group.add(car); // not baked: the car swaps in its detailed LOD model once loaded
        colliders.push(run.axis === 'x' ? rect(x, z, 4.6, 1.9) : rect(x, z, 1.9, 4.6));
      }
    }
    if (ctx.cx === 0 && ctx.cz === 0) busStop(group, colliders); // the spawn kerb is a bus stop (vehicleBusStop.ts)
    // litter baskets, mailbox, meters, bags, shelters, sheds, manholes (streetprops.ts)
    streetExtras({ stat, rng, colliders, near, village, noSheds: spawnView(ctx.cx, ctx.cz) }); // [districts] noSheds: the spawn view
    // a few sand3d props on the sidewalks (benches, planters, statues) — all enterable worlds
    for (let i = 0; i < 3; i++) {
      const run = rng.pick(runs);
      const t = rng.range(run.from + 3, run.to - 3);
      const x = run.axis === 'x' ? t : run.c - Math.sign(run.c) * 0.6;
      const z = run.axis === 'x' ? run.c - Math.sign(run.c) * 0.6 : t;
      if (near(x, z, 3)) continue;
      const role = rng.pick(['bench', 'streetprop', 'plant']);
      const e = pickModel(role, rng);
      if (!e) continue;
      const s = normScale(e);
      const sp = spawn(e, s);
      if (Math.max(sp.size.x, sp.size.z) > 2.6) continue;
      sp.obj.position.set(x, CURB, z);
      sp.obj.rotation.y = run.axis === 'x' ? 0 : Math.PI / 2;
      group.add(sp.obj);
      colliders.push(rect(x, z, Math.min(sp.size.x, 1.2), Math.min(sp.size.z, 1.2)));
      ctx.portals.push(objectPortal(e, x, z, sp.size, ctx.seed + i));
    }
  }

  private parkedModel(ctx: BCtx, e: ModelEntry, x: number, z: number, axis: 'x' | 'z') {
    const sp = spawn(e);
    const longX = sp.size.x >= sp.size.z;
    const rot = axis === 'x' ? (longX ? 0 : Math.PI / 2) : longX ? Math.PI / 2 : 0;
    sp.obj.position.set(x, 0, z);
    sp.obj.rotation.y = rot;
    ctx.group.add(sp.obj);
    const L = Math.max(sp.size.x, sp.size.z), Wd = Math.min(sp.size.x, sp.size.z);
    ctx.colliders.push(axis === 'x' ? rect(x, z, L, Wd) : rect(x, z, Wd, L));
    ctx.portals.push(objectPortal(e, x, z, new THREE.Vector3(axis === 'x' ? L : Wd, sp.size.y, axis === 'x' ? Wd : L), ctx.seed + Math.round(x * 7)));
  }
}

function objectPortal(e: ModelEntry, x: number, z: number, size: THREE.Vector3, seed: number): Portal {
  const r = new Rng(hashN(seed, 77));
  const biomes = ['town', 'toyland', 'candy', 'neon', 'snow', 'desert', 'circuit', 'metropolis'];
  return {
    box: new THREE.Box3(new THREE.Vector3(x - size.x / 2 - 0.15, 0, z - size.z / 2 - 0.15), new THREE.Vector3(x + size.x / 2 + 0.15, size.y + 0.2, z + size.z / 2 + 0.15)),
    label: `Shrink into “${e.title}”`,
    sub: `${e.role} · by ${e.author ?? 'unknown'} — a whole world inside`,
    target: { kind: 'city', seed: r.int(0, 2 ** 31), biome: r.pick(biomes), name: `Inside “${e.title}”`, source: e, sourceScale: Math.max(size.x, size.y, size.z) },
    shrink: Math.max(size.x, size.y, size.z),
  };
}


// [minimap] the NYC level maps itself (src/minimap.ts, src/nyc/minimap-nyc.ts)
registerMinimapSource((l) => (l instanceof NycLevel ? nycMinimapSource : null));
