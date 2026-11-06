import * as THREE from 'three';
import { Rng, hashN } from '../rng';
import { mat } from '../build';
import type { Portal, Rect } from '../level';
import { B, C, bake, canvasTex, lightFor, AX, SZ, AVE, ST } from './common';
import { FLEET, PAINTS, TAXI_YELLOW, fleetObject, paintMat, preloadFleet, ready, type Prepared } from './vehicleFleet';
import { busMesh } from './vehicleBus';
import { truckMesh } from './vehicleTruck';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';

/**
 * Cars, cabs and buses, and the traffic that drives them.
 *
 * Cars are detailed CC-BY models (see vehicleFleet.ts, CREDITS.md) with a near and a far LOD, tinted from a
 * weighted palette of real street colours; cabs are the Crown Vic taxi or a Prius/Accord in taxi yellow with a
 * roof light. Until the models have streamed in, a cars shows a simple stand-in that is swapped on load.
 * Buses are a procedural MTA New Flyer Xcelsior (vehicleBus.ts).
 */
export type VehicleKind = 'cab' | 'sedan' | 'bus' | 'truck';

/** which model a street car is, weighted like NYC traffic: lots of SUVs and sedans, some vans */
const SEDANS: [string, number][] = [
  ['accord', 18], ['prius', 12], ['charger', 8], ['suburban', 14], ['explorer', 12], ['escalade', 8], ['sprinter', 6],
];
const CABS: [string, number][] = [['taxi_cv', 4], ['prius', 3], ['accord', 3]];
/** black-car (livery) SUVs are usually black */
const BLACK_CAR = new Set(['suburban', 'escalade']);

function weighted<T>(rng: Rng, list: [T, number][]): T {
  let t = rng.next() * list.reduce((a, [, w]) => a + w, 0);
  for (const [v, w] of list) if ((t -= w) <= 0) return v;
  return list[list.length - 1][0];
}

let started = false;
const waiting: { obj: THREE.Group; id: string; paint: THREE.Material; cab: boolean }[] = [];
function startLoading() {
  if (started) return;
  started = true;
  preloadFleet().then(() => {
    for (const w of waiting.splice(0)) dress(w.obj, w.id, w.paint, w.cab);
  });
}

/** put the real model into a car object (replacing the stand-in) */
function dress(obj: THREE.Group, id: string, paint: THREE.Material, cab: boolean) {
  const p = ready.get(id);
  if (!p) return;
  for (const c of [...obj.children]) if (c.userData.standin) obj.remove(c);
  const lod = fleetObject(p, paint);
  obj.add(lod);
  if (cab && id !== 'taxi_cv') {
    let top = 0, zc = 0;
    for (const part of p.lod0) {
      const bb = part.geo.boundingBox!;
      if (bb.max.y > top) top = bb.max.y;
    }
    zc = id === 'prius' ? 0.15 : 0.25;
    const sign = roofSign();
    sign.position.set(0, top - 0.02, zc);
    obj.add(sign);
    for (const d of taxiDecals(id, p)) lod.levels[0].object.add(d);
  }
}

/** door livery for painted cabs: the black "T" roundel + NYC on the front doors, medallion number on the rear quarter */
const decalCache = new Map<string, THREE.Mesh[]>();
const DECAL_AT: Record<string, { door: number; quarter: number; y: number }> = {
  prius: { door: -0.35, quarter: 1.45, y: 0.72 },
  accord: { door: -0.45, quarter: 1.55, y: 0.68 },
};
let decalMats: { logo: THREE.Material; num: THREE.Material } | null = null;
function taxiDecals(id: string, p: Prepared): THREE.Mesh[] {
  const at = DECAL_AT[id];
  const body = p.lod0.find((x) => x.mat === 'paint');
  if (!at || !body) return [];
  let out = decalCache.get(id);
  if (!out) {
    decalMats ??= {
      logo: decalMat(
        canvasTex(256, 128, (g) => {
          g.fillStyle = '#111';
          g.beginPath();
          g.arc(64, 64, 58, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = TAXI_YELLOW;
          g.fillRect(34, 30, 60, 14);
          g.fillRect(57, 30, 14, 66);
          g.fillStyle = '#111';
          g.font = 'bold 44px Arial';
          g.textBaseline = 'middle';
          g.fillText('NYC', 134, 66);
        }),
      ),
      num: decalMat(
        canvasTex(256, 64, (g) => {
          g.fillStyle = '#111';
          g.font = 'bold 40px Arial';
          g.textBaseline = 'middle';
          g.fillText('7J42', 8, 34);
        }),
      ),
    };
    const mesh = new THREE.Mesh(body.geo);
    mesh.updateMatrixWorld();
    out = [];
    for (const s of [-1, 1]) {
      const ori = new THREE.Euler(0, (s * Math.PI) / 2, 0);
      // sample the body surface at the door so the decal box sits on it
      const hit = new THREE.Raycaster(new THREE.Vector3(s * 2, at.y, at.door), new THREE.Vector3(-s, 0, 0)).intersectObject(mesh)[0];
      const x = hit ? hit.point.x : s * 0.9;
      const flip = 1;
      const logo = new THREE.Mesh(new DecalGeometry(mesh, new THREE.Vector3(x, at.y, at.door), ori, new THREE.Vector3(0.62 * flip, 0.31, 0.5)), decalMats.logo);
      const hq = new THREE.Raycaster(new THREE.Vector3(s * 2, at.y + 0.05, at.quarter), new THREE.Vector3(-s, 0, 0)).intersectObject(mesh)[0];
      const num = new THREE.Mesh(new DecalGeometry(mesh, new THREE.Vector3(hq ? hq.point.x : x, at.y + 0.05, at.quarter), ori, new THREE.Vector3(0.36 * flip, 0.09, 0.5)), decalMats.num);
      out.push(logo, num);
    }
    out.forEach((m) => (m.userData.owned = false));
    decalCache.set(id, out);
  }
  return out.map((m) => m.clone());
}
function decalMat(map: THREE.Texture) {
  return new THREE.MeshStandardMaterial({ map, transparent: true, roughness: 0.35, polygonOffset: true, polygonOffsetFactor: -4, depthWrite: false });
}

/** NYC taxi roof light: a slim white box with "TAXI" and the medallion number, lit when the cab is free */
let signParts: { geo: THREE.BufferGeometry; mats: THREE.Material[]; base: THREE.BufferGeometry; baseMat: THREE.Material } | null = null;
function roofSign(): THREE.Object3D {
  if (!signParts) {
    const tex = canvasTex(256, 64, (g) => {
      g.fillStyle = '#f4f1e6';
      g.fillRect(0, 0, 256, 64);
      g.fillStyle = '#111';
      g.font = 'bold 30px Arial';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('TAXI', 128, 26);
      g.font = 'bold 13px Arial';
      g.fillText('NYC  7J' + (10 + ((Math.random() * 89) | 0)), 128, 52);
    });
    const face = new THREE.MeshStandardMaterial({ color: '#fff', map: tex, emissive: '#fff6dc', emissiveMap: tex, emissiveIntensity: 0.55, roughness: 0.3 });
    const side = new THREE.MeshStandardMaterial({ color: '#e8e4d8', roughness: 0.35 });
    signParts = {
      geo: new THREE.BoxGeometry(0.78, 0.24, 0.2),
      // box faces: +x, -x, +y, -y, +z, -z
      mats: [side, side, side, side, face, face],
      base: new THREE.BoxGeometry(0.5, 0.04, 0.3),
      baseMat: mat('#111', { rough: 0.6 }),
    };
  }
  const g = new THREE.Group();
  const m = new THREE.Mesh(signParts.geo, signParts.mats);
  m.position.y = 0.16;
  m.castShadow = true;
  g.add(m);
  const b = new THREE.Mesh(signParts.base, signParts.baseMat);
  b.position.y = 0.02;
  g.add(b);
  g.traverse((o) => (o.userData.owned = false));
  return g;
}

/** a low-detail stand-in shown until the models are loaded */
const standinCache = new Map<string, THREE.Group>();
function standin(color: string, len: number, wid: number, tall: boolean): THREE.Group {
  const key = `${color}|${len}|${wid}|${tall}`;
  let s = standinCache.get(key);
  if (!s) {
    const g = new THREE.Group();
    const body = mat(color, { rough: 0.35, metal: 0.4 });
    const black = mat('#111', { rough: 0.8 });
    const h = tall ? 1.85 : 1.45;
    B(g, body, wid, h * 0.45, len, 0, 0.3, 0);
    B(g, M2.glass, wid * 0.92, h * 0.4, len * 0.55, 0, 0.3 + h * 0.45, tall ? 0.2 : 0.1);
    for (const z of [-len * 0.31, len * 0.31])
      for (const x of [-wid / 2 + 0.15, wid / 2 - 0.15]) {
        const t = C(g, black, 0.34, 0.24, x, 0, z, false);
        t.rotation.z = Math.PI / 2;
        t.position.y = 0.34;
      }
    s = bake(g);
    standinCache.set(key, s);
  }
  const c = s.clone();
  c.userData.standin = true;
  c.traverse((o) => (o.userData.owned = false));
  return c;
}
const M2 = { glass: mat('#1e2a33', { rough: 0.15, metal: 0.4 }) };

/**
 * A parked/showcase car for other areas (dealership lots, kerbs): the same detailed LOD model as street traffic
 * (shared geometry and materials, ~1-8 draw calls by distance). userData.len/wid give its footprint; nose toward -z;
 * stands on y=0. Call preloadFleet() first if it must be detailed on the first frame.
 */
export function parkedCar(kind: VehicleKind, rng: Rng): THREE.Group {
  return carMesh(kind, rng);
}

export function carMesh(kind: VehicleKind, rng: Rng): THREE.Group {
  if (kind === 'bus') return busMesh(rng);
  if (kind === 'truck') return truckMesh(rng);
  startLoading();
  const id = kind === 'cab' ? weighted(rng, CABS) : weighted(rng, SEDANS);
  const f = FLEET[id];
  let color: string, metal: number;
  if (kind === 'cab') {
    color = TAXI_YELLOW;
    metal = 0.15;
  } else if (BLACK_CAR.has(id) && rng.chance(0.6)) {
    color = '#0a0b0d';
    metal = 0.3;
  } else {
    const p = weighted(rng, PAINTS.map((q) => [q, q.w] as [typeof q, number]));
    color = p.c;
    metal = p.metal;
  }
  const paint = paintMat(color, metal);
  const obj = new THREE.Group();
  obj.userData.len = f.len;
  obj.userData.wid = f.wid;
  obj.userData.model = id;
  if (ready.has(id)) dress(obj, id, paint, kind === 'cab');
  else {
    obj.add(standin(f.paint ? color : id === 'taxi_cv' ? TAXI_YELLOW : '#e8e8e8', f.len, f.wid, /tahoe|suburban|explorer|escalade|sprinter/.test(id)));
    waiting.push({ obj, id, paint, cab: kind === 'cab' });
  }
  return obj;
}

export interface Car {
  obj: THREE.Group;
  axis: 'x' | 'z';
  dir: number;
  line: number;
  t: number;
  v: number;
  vmax: number;
  len: number;
  wid: number;
  rect: Rect;
}

export class Traffic {
  cars: Car[] = [];
  portals: Portal[] = [];
  private rng: Rng;
  constructor(private group: THREE.Group, seed: number) {
    this.rng = new Rng(hashN(seed, 404));
  }
  rects() {
    return this.cars.map((c) => c.rect);
  }
  private place(c: Car, p: THREE.Vector3) {
    const r = this.rng;
    c.axis = r.chance(0.6) ? 'z' : 'x';
    if (c.axis === 'z') {
      const k = Math.round(p.x / AX - 0.5) + r.int(-1, 1);
      c.dir = k % 2 === 0 ? -1 : 1; // one-way avenues alternate
      c.line = (k + 0.5) * AX + r.pick([-3.6, 0, 3.6]);
      c.t = p.z - c.dir * r.range(60, 140);
    } else {
      const k = Math.round(p.z / SZ - 0.5) + r.int(-2, 2);
      c.dir = k % 2 === 0 ? 1 : -1;
      c.line = (k + 0.5) * SZ;
      c.t = p.x - c.dir * r.range(60, 140);
    }
    c.v = c.vmax;
    c.obj.rotation.y = c.axis === 'z' ? (c.dir > 0 ? Math.PI : 0) : c.dir > 0 ? -Math.PI / 2 : Math.PI / 2;
  }
  update(dt: number, p: THREE.Vector3, time: number) {
    while (this.cars.length < 26) {
      const kind: VehicleKind = this.rng.chance(0.07) ? 'bus' : this.rng.chance(0.07) ? 'truck' : this.rng.chance(0.5) ? 'cab' : 'sedan';
      const obj = carMesh(kind, this.rng);
      this.group.add(obj);
      const c: Car = { obj, axis: 'z', dir: 1, line: 0, t: 0, v: 0, vmax: this.rng.range(9, 14), len: obj.userData.len ?? 4.8, wid: obj.userData.wid ?? 1.9, rect: { minX: 0, minZ: 0, maxX: 0, maxZ: 0 } };
      this.place(c, p);
      this.cars.push(c);
    }
    for (const c of this.cars) {
      const along = c.axis === 'x' ? p.x : p.z;
      const across = c.axis === 'x' ? p.z : p.x;
      if (Math.abs(c.t - along) > 170 || Math.abs(c.line - across) > 200) this.place(c, p);
      // red light: stop before the next intersection
      let target = c.vmax;
      const period = c.axis === 'z' ? SZ : AX;
      const halfCross = c.axis === 'z' ? ST / 2 : AVE / 2;
      const front = c.t + (c.dir * c.len) / 2;
      const k = c.dir > 0 ? Math.ceil((front - period / 2 + halfCross + 4) / period) : Math.floor((front - period / 2 - halfCross - 4) / period);
      const centre = (k + 0.5) * period;
      const stopAt = centre - c.dir * (halfCross + 4.2);
      const dist = (stopAt - front) * c.dir;
      if (lightFor(c.axis, time) !== 'g' && dist > -0.5 && dist < 30) target = Math.min(target, Math.max(0, (dist - 0.5) * 1.2));
      // follow the car ahead in the same lane
      for (const o of this.cars) {
        if (o === c || o.axis !== c.axis || o.dir !== c.dir || Math.abs(o.line - c.line) > 1) continue;
        const gap = (o.t - c.t) * c.dir - (o.len + c.len) / 2;
        if (gap > -1 && gap < 25) target = Math.min(target, Math.max(0, (gap - 2.5) * 1.0));
      }
      // don't run the player over
      const pg = (along - c.t) * c.dir - c.len / 2;
      if (Math.abs(across - c.line) < c.wid && pg > -1 && pg < 12) target = 0;
      c.v += (target - c.v) * Math.min(1, dt * (target < c.v ? 4 : 1.2));
      c.t += c.dir * c.v * dt;
      const x = c.axis === 'x' ? c.t : c.line, z = c.axis === 'x' ? c.line : c.t;
      c.obj.position.set(x, 0, z);
      const wheels = c.obj.userData.wheels as THREE.Object3D[] | undefined;
      if (wheels) for (const w of wheels) w.rotation.x -= (c.v * dt) / c.obj.userData.wheelR;
      const hx = (c.axis === 'x' ? c.len : c.wid) / 2, hz = (c.axis === 'x' ? c.wid : c.len) / 2;
      c.rect.minX = x - hx; c.rect.maxX = x + hx; c.rect.minZ = z - hz; c.rect.maxZ = z + hz;
    }
  }
}


