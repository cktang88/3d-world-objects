import * as THREE from 'three';
import { AX, SZ, AVE, ST, BX, BZ, LX, LZ, CURB, RX, RZ, avenueName, streetName, bake, unitBox, unitCyl, unitSphere, B, C, canvasTex, M, SIG, lightFor, type Side } from './nyc/common';
import { signalPole, nameSign, lampPost, tree, hydrant, subway } from './nyc/streetprops';
import { wetSurface, getNight, onTimeChange } from './lighting';
import { carMesh, Traffic } from './nyc/vehicles';
import { Pedestrians } from './nyc/people';
export { avenueName, streetName };
export { SHOPS } from './nyc/buildings';
export { setNight } from './nyc/buildings';
import { building, makeCtx, finishBuildings, setBlockDetail, setNight as setBuildingNight, type BCtx } from './nyc/buildings';
// lighting.ts drives the time of day: lit rooms, shop interiors and signs follow it
onTimeChange((_t, n) => setBuildingNight(n));
setBuildingNight(getNight());
import { Rng, hashN } from './rng';
import { pickModel, spawn, normScale, type ModelEntry } from './assets';
import { mat, glow } from './build';
import { pbr } from './pbr';
import type { Env, Level, LevelDesc, Portal, Rect } from './level';
import { disposeTree, rect } from './level';
import { BIOMES } from './biomes';

// ---------------------------------------------------------------- static geometry baking

// ---------------------------------------------------------------- textures

let roadTexCache: THREE.Texture | null = null;
function nycRoadTex() {
  if (roadTexCache) return roadTexCache;
  const P = 10; // px per metre
  roadTexCache = canvasTex(AX * P, SZ * P, (g) => {
    const W = AX * P, H = SZ * P;
    g.fillStyle = '#3d3e41';
    g.fillRect(0, 0, W, H);
    const img = g.getImageData(0, 0, W, H);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (Math.random() - 0.5) * 22;
      img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
    }
    g.putImageData(img, 0, 0);
    // patches and manholes
    for (let i = 0; i < 30; i++) {
      g.fillStyle = `rgba(${Math.random() < 0.5 ? '20,20,22' : '80,80,84'},0.35)`;
      g.fillRect(Math.random() * W, Math.random() * H, 20 + Math.random() * 60, 10 + Math.random() * 40);
    }
    g.fillStyle = '#26272a';
    for (const [x, y] of [[4, 20], [116, 44], [30, 2.5], [90, 61.5]]) {
      g.beginPath();
      g.arc(x * P, y * P, 0.45 * P, 0, Math.PI * 2);
      g.fill();
    }
    // avenue lane lines (avenue halves at x=0..8 and 112..120); streets at z=0..5 and 59..64
    g.fillStyle = 'rgba(235,235,235,0.85)';
    for (let z = ST / 2 + 1; z < SZ - ST / 2 - 1; z += 6) {
      for (const x of [0, 4.2, AX - 4.2, AX]) g.fillRect(x * P - 1.2, z * P, 2.4, 3 * P);
    }
    for (let x = AVE / 2 + 1; x < AX - AVE / 2 - 1; x += 6) {
      for (const y of [0, SZ]) g.fillRect(x * P, y * P - 1.2, 3 * P, 2.4);
    }
    // crosswalks: across the avenue near the corners, and across the street
    g.fillStyle = 'rgba(240,240,240,0.92)';
    for (const z0 of [ST / 2 + 0.4, SZ - ST / 2 - 3.4]) {
      for (const xs of [[0, AVE / 2], [AX - AVE / 2, AX]]) {
        for (let x = xs[0] + 0.3; x < xs[1] - 0.2; x += 1.2) g.fillRect(x * P, z0 * P, 0.6 * P, 3 * P);
      }
    }
    for (const x0 of [AVE / 2 + 0.4, AX - AVE / 2 - 3.4]) {
      for (const zs of [[0, ST / 2], [SZ - ST / 2, SZ]]) {
        for (let z = zs[0] + 0.3; z < zs[1] - 0.2; z += 1.2) g.fillRect(x0 * P, z * P, 3 * P, 0.6 * P);
      }
    }
    // stop bars
    for (const z0 of [ST / 2 + 3.9, SZ - ST / 2 - 4.3]) for (const xs of [[0.3, AVE / 2], [AX - AVE / 2, AX - 0.3]]) g.fillRect(xs[0] * P, z0 * P, (xs[1] - xs[0]) * P, 0.4 * P);
  });
  return roadTexCache;
}

// ---------------------------------------------------------------- materials

let roadMaterial: THREE.MeshStandardMaterial | null = null;
/** road markings from the canvas; surface relief and roughness from photo-scanned asphalt */
function roadMat() {
  if (roadMaterial) return roadMaterial;
  const m = new THREE.MeshStandardMaterial({ map: nycRoadTex(), roughness: 1 });
  roadMaterial = m;
  wetSurface(m); // lighting.ts: wet sheen at night
  const p = pbr('nyc_asphalt');
  p?.ready.then(() => {
    const rep = (t: THREE.Texture | null) => {
      if (!t) return null;
      const c = t.clone();
      c.repeat.set(AX / p.tile[0], SZ / p.tile[1]);
      c.needsUpdate = true;
      return c;
    };
    m.normalMap = rep(p.nor);
    m.normalScale.setScalar(1.3);
    m.roughnessMap = rep(p.arm);
    m.needsUpdate = true;
  });
  return m;
}
interface Chunk {
  group: THREE.Group;
  colliders: Rect[];
  portals: Portal[];
}

export class NycLevel implements Level {
  name: string;
  group = new THREE.Group();
  spawn = { pos: new THREE.Vector3(BX - 2.6, 0, BZ - 3.2), yaw: 0.1 };
  env: Env;
  private chunks = new Map<string, Chunk>();
  private seed: number;
  private nearPortals: Portal[] = [];
  private nearCols: Rect[] = [];
  private lastKey = '';
  private traffic: Traffic;
  private peds: Pedestrians;
  private steam: THREE.Sprite[] = [];

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
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) this.ensure(dx, dz);
    this.refresh(0, 0);
    this.traffic = new Traffic(this.group, this.seed);
    this.peds = new Pedestrians(this.group, this.seed);
  }

  colliders() {
    return this.nearCols.concat(this.traffic.rects());
  }
  portals() {
    return this.nearPortals.concat(this.traffic.portals);
  }

  update(dt: number, p: THREE.Vector3, time: number) {
    const cx = Math.round(p.x / AX), cz = Math.round(p.z / SZ);
    let built = 0;
    for (let ring = 0; ring <= Math.max(RX, RZ) && built < 1; ring++) {
      for (let dz = -Math.min(ring, RZ); dz <= Math.min(ring, RZ) && built < 1; dz++)
        for (let dx = -Math.min(ring, RX); dx <= Math.min(ring, RX) && built < 1; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          if (this.ensure(cx + dx, cz + dz)) built++;
        }
    }
    for (const [k, ch] of this.chunks) {
      const [x, z] = k.split(',').map(Number);
      if (Math.abs(x - cx) > RX + 1 || Math.abs(z - cz) > RZ + 1) {
        this.group.remove(ch.group);
        disposeTree(ch.group);
        this.chunks.delete(k);
      }
    }
    // LOD: small details (brackets, balusters, sashes, AC units) only on nearby blocks
    for (const [k, ch] of this.chunks) {
      const [x, z] = k.split(',').map(Number);
      setBlockDetail(ch.group, Math.abs(x - cx) <= 1 && Math.abs(z - cz) <= 1);
    }
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
    this.peds.update(dt, p);
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
    const ch = this.block(cx, cz);
    const ox = cx * AX, oz = cz * SZ;
    ch.group.position.set(ox, 0, oz);
    for (const c of ch.colliders) { c.minX += ox; c.maxX += ox; c.minZ += oz; c.maxZ += oz; }
    for (const p of ch.portals) {
      p.box.translate(new THREE.Vector3(ox, 0, oz));
      p.returnPos?.add(new THREE.Vector3(ox, 0, oz));
    }
    this.group.add(ch.group);
    this.chunks.set(k, ch);
    return true;
  }

  // ------------------------------------------------------------ one block

  private block(cx: number, cz: number): Chunk {
    const rng = new Rng(hashN(this.seed, cx, cz));
    const group = new THREE.Group();
    const stat = new THREE.Group(); // merged at the end
    const colliders: Rect[] = [];
    const portals: Portal[] = [];
    // district character: smooth-ish noise across the grid
    const tower = 0.5 + 0.5 * Math.sin(cx * 0.9 + this.seed * 0.001) * Math.cos(cz * 0.37 + 1.3);
    const village = tower < 0.35;

    // road + sidewalk
    const road = new THREE.Mesh(new THREE.PlaneGeometry(AX, SZ), roadMat());
    road.rotation.x = -Math.PI / 2;
    road.receiveShadow = true;
    road.userData.owned = true;
    group.add(road);
    const sw = new THREE.PlaneGeometry(BX * 2, BZ * 2);
    const uv = sw.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * BX * 2) / 3, (uv.getY(i) * BZ * 2) / 3);
    const swm = new THREE.Mesh(sw, M.sidewalk());
    swm.rotation.x = -Math.PI / 2;
    swm.position.y = CURB;
    stat.add(swm);
    const curb = M.curb();
    B(stat, curb, BX * 2, CURB, 0.25, 0, 0, -BZ + 0.125, false);
    B(stat, curb, BX * 2, CURB, 0.25, 0, 0, BZ - 0.125, false);
    B(stat, curb, 0.25, CURB, BZ * 2, -BX + 0.125, 0, 0, false);
    B(stat, curb, 0.25, CURB, BZ * 2, BX - 0.125, 0, 0, false);
    // the hidden backyard core of the block
    B(stat, mat('#5a564f'), LX * 2 - 1, 2.5, LZ * 2 - 1, 0, 0, 0, false);

    const ctx: BCtx = makeCtx(rng, group, stat, cx, cz, hashN(this.seed, cx, cz, 5));
    ctx.colliders = colliders;
    ctx.portals = portals;

    // avenue frontage: both ends of the block
    for (const end of [-1, 1]) {
      const x0 = end < 0 ? -LX : LX - 20;
      const x1 = end < 0 ? -LX + 20 : LX;
      const side: Side = end < 0 ? 'W' : 'E';
      const big = tower > 0.62 && rng.chance(0.7);
      if (big) {
        building(ctx, { minX: x0, maxX: x1, minZ: -LZ, maxZ: LZ }, side, 'tower', rng.int(22, 48), true, [true, true]);
      } else {
        const n = rng.int(2, 3);
        const cuts = [-LZ];
        for (let i = 1; i < n; i++) cuts.push(-LZ + (i * 2 * LZ) / n + rng.range(-3, 3));
        cuts.push(LZ);
        for (let i = 0; i < n; i++) {
          const type = tower > 0.45 ? rng.pick(['prewar', 'prewar', 'midrise'] as const) : rng.pick(['tenement', 'prewar', 'midrise'] as const);
          const floors = type === 'prewar' ? rng.int(9, 18) : type === 'midrise' ? rng.int(6, 12) : rng.int(5, 6);
          building(ctx, { minX: x0, maxX: x1, minZ: cuts[i], maxZ: cuts[i + 1] }, side, type, floors, true, [i === 0, i === n - 1]);
        }
      }
    }
    // mid-block rows facing the streets
    for (const row of [-1, 1]) {
      const side: Side = row < 0 ? 'N' : 'S';
      let x = -LX + 20;
      while (x < LX - 20 - 3) {
        const type = village ? rng.pick(['brownstone', 'brownstone', 'brownstone', 'tenement'] as const) : tower > 0.6 ? rng.pick(['midrise', 'tenement', 'prewar', 'castiron'] as const) : rng.pick(['tenement', 'tenement', 'brownstone', 'castiron', 'midrise'] as const);
        let w = type === 'brownstone' ? rng.range(5.5, 7) : type === 'castiron' ? rng.range(9, 14) : rng.range(7, 10);
        if (x + w > LX - 20 - 3) w = LX - 20 - x;
        const depth = rng.range(14, 19);
        const r: Rect = row < 0 ? { minX: x, maxX: x + w, minZ: -LZ, maxZ: -LZ + depth } : { minX: x, maxX: x + w, minZ: LZ - depth, maxZ: LZ };
        const floors = type === 'brownstone' ? rng.int(3, 5) : type === 'tenement' ? rng.int(4, 6) : type === 'castiron' ? rng.int(5, 7) : type === 'prewar' ? rng.int(9, 14) : rng.int(7, 12);
        const store = type !== 'brownstone' && rng.chance(type === 'tenement' ? 0.6 : 0.75);
        building(ctx, r, side, type, floors, store, [false, false]);
        x += w;
      }
    }
    this.street(ctx, village, tower);

    // merge everything static into a few meshes
    const baked = bake(stat);
    group.add(baked);
    finishBuildings(ctx);
    // dispose the per-building geometries that were merged
    stat.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry !== unitBox && m.geometry !== unitCyl && m.geometry !== unitSphere) m.geometry.dispose();
    });
    return { group, colliders, portals };
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
      group.add(nameSign(st, x, 3.6, z, 0));
      group.add(nameSign(ave, x, 3.9, z, Math.PI / 2));
      if (rng.chance(0.08)) {
        // a corner trash can and a mailbox
        B(stat, mat('#1d5c3a', { rough: 0.7 }), 0.6, 0.95, 0.6, x - sx * 1.6, CURB, z - sz * 0.8);
      }
    }
    if (rng.chance(0.35)) {
      const sx = rng.chance(0.5) ? -1 : 1, sz = rng.chance(0.5) ? -1 : 1;
      subway(stat, group, sx * (BX - 2.2), sz * (BZ - 9), ctx.cz, rng);
      colliders.push(rect(sx * (BX - 2.2), sz * (BZ - 9), 2.2, 5.4));
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
        lampPost(stat, group, x, z, run.axis, run.c > 0 ? 1 : -1);
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
        if (!near(x, z)) for (let k = 0; k < 3; k++) {
          const ox = run.axis === 'x' ? k * 0.55 : 0, oz = run.axis === 'z' ? k * 0.55 : 0;
          B(stat, mat(['#c4161c', '#1e4fa3', '#f0b400'][k], { rough: 0.6 }), 0.45, 1.05, 0.45, x + ox, CURB, z + oz);
        }
      }
      if (run.ave && rng.chance(0.35)) {
        // steam stack in the avenue
        const [x, z] = P(rng.range(run.from, run.to));
        const ax = run.axis === 'z' ? x + Math.sign(x) * 3.5 : x;
        const az = run.axis === 'x' ? z + Math.sign(z) * 3 : z;
        const sm = mat('#f07a1e', { rough: 0.6 });
        const wm = mat('#f2f2f2', { rough: 0.6 });
        for (let k = 0; k < 6; k++) C(stat, k % 2 ? wm : sm, 0.35, 0.5, ax, k * 0.5, az);
        colliders.push(rect(ax, az, 0.8, 0.8));
        for (let k = 0; k < 3; k++) {
          const s = glow('#ffffff', 1.5, ax, 3, az, 0.4);
          (s.material as THREE.SpriteMaterial).blending = THREE.NormalBlending;
          s.material = (s.material as THREE.SpriteMaterial).clone();
          s.userData.ph = k / 3;
          s.userData.y = 3;
          group.add(s);
          this.steam.push(s);
        }
      }
      // parked cars on streets (and sand3d vehicles you can shrink into)
      const lane = run.axis === 'x' ? (BZ + 1.15) * Math.sign(run.c) : (BX + 1.15) * Math.sign(run.c);
      for (let t = run.from + 4; t < run.to - 4; t += rng.range(6.5, 9)) {
        if (!rng.chance(run.ave ? 0.35 : 0.55)) continue;
        const x = run.axis === 'x' ? t : lane;
        const z = run.axis === 'x' ? lane : t;
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
        stat.add(car);
        colliders.push(run.axis === 'x' ? rect(x, z, 4.6, 1.9) : rect(x, z, 1.9, 4.6));
      }
    }
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

