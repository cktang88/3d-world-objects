import * as THREE from 'three';
import { Rng, hashN } from '../rng';
import { mat } from '../build';
import type { Portal, Rect } from '../level';
import { B, C, bake, canvasTex, lightFor, AX, SZ, AVE, ST, CYCLE, SIGNAL } from './common';
import { laneOpen } from './districts'; // [districts]
import { FLEET, PAINTS, TAXI_YELLOW, fleetInstances, fleetTimings, loadFleet, loadNear, nearObject, paintMat, preloadFleet, ready, type Prepared } from './vehicleFleet';
import { busMesh } from './vehicleBus';
import { truckMesh } from './vehicleTruck';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';

/**
 * Cars, cabs and buses, and the traffic that drives them.
 *
 * Cars are detailed CC-BY models (see vehicleFleet.ts, CREDITS.md): a ~15k-tri near LOD per car within 15 m,
 * and instanced mid (~5k, to 40 m) and far (~2-4k) LODs shared by every car of a model; tinted from a
 * weighted palette of real street colours; cabs are the Crown Vic taxi or a Prius/Accord in taxi yellow with a
 * roof light. Until the models have streamed in, a cars shows a simple stand-in that is swapped on load.
 * Buses are a procedural MTA New Flyer Xcelsior (vehicleBus.ts).
 */
export type VehicleKind = 'cab' | 'sedan' | 'bus' | 'truck';

/** which model a street car is, weighted like NYC traffic: lots of SUVs and sedans, some vans */
const SEDANS: [string, number][] = [
  ['accord', 10], ['accord19', 12], ['prius', 12], ['charger', 8], ['suburban', 14], ['explorer', 12], ['escalade', 8], ['sprinter', 6],
];
const CABS: [string, number][] = [['taxi_cv', 3], ['prius', 4], ['accord', 3]];
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
  // request every far LOD, then every mid LOD; each model's cars swap their stand-in as soon as that
  // model is in (not when the whole fleet is: the spawn view showed boxes for seconds)
  void preloadFleet();
  for (const id of Object.keys(FLEET))
    loadFleet(id).then((p) => {
      if (!p) return;
      ready.set(id, p);
      if (fleetTimings[id]) fleetTimings[id].dressed = Math.round(performance.now());
      for (let i = waiting.length - 1; i >= 0; i--) {
        const w = waiting[i];
        if (w.id !== id) continue;
        waiting.splice(i, 1);
        dress(w.obj, w.id, w.paint, w.cab);
      }
    });
}

/**
 * Put the real model into a car object (replacing the stand-in): first the instanced mid/far LODs (small files,
 * in within seconds), then the near-LOD meshes once that model's near file has loaded.
 */
function dress(obj: THREE.Group, id: string, paint: THREE.Material, cab: boolean) {
  const p = ready.get(id);
  if (!p) return;
  for (const c of [...obj.children]) if (c.userData.standin) obj.remove(c);
  const entry = fleetInstances.register(obj, id, (paint as THREE.MeshStandardMaterial).color, null);
  if (cab && id !== 'taxi_cv') {
    let top = 0;
    for (const part of p.lod1) top = Math.max(top, part.geo.boundingBox!.max.y);
    const sign = roofSign();
    sign.position.set(0, top - 0.02, id === 'prius' ? 0.15 : 0.25);
    obj.add(sign);
  }
  const addNear = (q: Prepared | null) => {
    if (!q?.nearReady) return;
    // near LOD as real meshes (shown within FLEET_LOD.NEAR); mid/far are drawn by the shared instance batches
    const { near, wheels, wheelR, brake } = nearObject(q, paint);
    near.visible = false;
    obj.add(near);
    if (wheels.length) {
      obj.userData.wheels = wheels;
      obj.userData.wheelR = wheelR;
    }
    if (brake) {
      obj.add(brake);
      obj.userData.brake = brake;
    }
    if (cab && id !== 'taxi_cv') for (const d of taxiDecals(id, q)) near.add(d);
    // the Crown Vic's texture carries a generic "Yellow Cab" livery: paint the NYC one over it
    if (id === 'taxi_cv') for (const d of crownVicLivery(q)) near.add(d);
    entry.near = near;
  };
  if (p.nearReady) addNear(p);
  else loadNear(id).then(addNear);
}

/**
 * Yellow cover panels in the body's own texture colour, projected over the Crown Vic's "Yellow Cab" oval (front
 * doors) and "TAXI SERVICE" / fare text (rear doors): the NYC "T" roundel + NYC, and the medallion number.
 */
let cvCache: THREE.Mesh[] | null = null;
function crownVicLivery(p: Prepared): THREE.Mesh[] {
  if (!cvCache) {
    // the body is the textured part with the most triangles
    const body = [...p.lod0].filter((x) => x.mat !== 'paint' && (x.mat as THREE.MeshStandardMaterial).map).sort((a, b) => (b.geo.index?.count ?? 0) - (a.geo.index?.count ?? 0))[0];
    if (!body) return [];
    const bg = '#' + bodyYellow((body.mat as THREE.MeshStandardMaterial).map!).getHexString(THREE.SRGBColorSpace);
    const front = decalMat(
      canvasTex(512, 256, (g) => {
        g.fillStyle = bg;
        g.fillRect(0, 0, 512, 256);
        g.fillStyle = '#111';
        g.beginPath();
        g.arc(150, 128, 78, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = bg;
        g.fillRect(110, 78, 80, 18);
        g.fillRect(140, 78, 20, 92);
        g.fillStyle = '#111';
        g.font = 'bold 64px Arial';
        g.textBaseline = 'middle';
        g.fillText('NYC', 250, 132);
      }),
      false,
    );
    const rear = decalMat(
      canvasTex(512, 128, (g) => {
        g.fillStyle = bg;
        g.fillRect(0, 0, 512, 128);
        g.fillStyle = '#111';
        g.font = 'bold 30px Arial';
        g.textBaseline = 'middle';
        g.fillText('7J42', 24, 40);
        g.font = '20px Arial';
        g.fillText('NYC TAXI  ·  $3.00 initial charge', 24, 92);
      }),
      false,
    );
    const mesh = new THREE.Mesh(body.geo);
    mesh.updateMatrixWorld();
    cvCache = [];
    for (const s of [-1, 1]) {
      const ori = new THREE.Euler(0, (s * Math.PI) / 2, 0);
      const at = (y: number, z: number) => {
        const hit = new THREE.Raycaster(new THREE.Vector3(s * 2, y, z), new THREE.Vector3(-s, 0, 0)).intersectObject(mesh)[0];
        return new THREE.Vector3(hit ? hit.point.x : s * 0.95, y, z);
      };
      cvCache.push(new THREE.Mesh(new DecalGeometry(mesh, at(0.66, -0.5), ori, new THREE.Vector3(1.05, 0.52, 0.5)), front));
      cvCache.push(new THREE.Mesh(new DecalGeometry(mesh, at(0.86, 0.62), ori, new THREE.Vector3(0.95, 0.24, 0.5)), rear));
    }
    cvCache.forEach((m) => (m.userData.owned = false));
  }
  return cvCache.map((m) => m.clone());
}
/** the brightest half of a texture's colours, averaged (the body colour of an atlas) */
function bodyYellow(t: THREE.Texture): THREE.Color {
  const c = new THREE.Color(TAXI_YELLOW);
  try {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 16;
    const g = cv.getContext('2d')!;
    g.drawImage(t.image as CanvasImageSource, 0, 0, 16, 16);
    const d = g.getImageData(0, 0, 16, 16).data;
    const px: number[][] = [];
    for (let i = 0; i < d.length; i += 4) if (d[i] > d[i + 2] + 60) px.push([d[i], d[i + 1], d[i + 2]]); // yellowish only
    if (px.length) c.setRGB(...([0, 1, 2].map((k) => px.reduce((a, q) => a + q[k], 0) / px.length / 255) as [number, number, number]), THREE.SRGBColorSpace);
  } catch {
    /* keep taxi yellow */
  }
  return c;
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
function decalMat(map: THREE.Texture, transparent = true) {
  return new THREE.MeshStandardMaterial({ map, transparent, roughness: 0.4, polygonOffset: true, polygonOffsetFactor: -4, depthWrite: !transparent });
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

/**
 * A low-detail stand-in shown until the model is loaded (the first seconds after spawn): a car silhouette,
 * not a box. Side profile (nose toward -z) extruded across the width: a lower body with a sloped hood and
 * boot, a narrower glass cabin with raked windshield and rear window, a roof in the paint colour, wheels.
 */
const standinCache = new Map<string, THREE.Group>();
function profile(pts: [number, number][], width: number) {
  const sh = new THREE.Shape();
  pts.forEach(([z, y], i) => (i ? sh.lineTo(z, y) : sh.moveTo(z, y)));
  sh.closePath();
  const g = new THREE.ExtrudeGeometry(sh, { depth: width, bevelEnabled: false });
  // shape x = car z, extruded along +z = car x: turn it so the extrusion runs across the car, centred
  g.rotateY(-Math.PI / 2);
  g.translate(width / 2, 0, 0);
  return g;
}
export function standin(color: string, len: number, wid: number, tall: boolean): THREE.Group {
  const key = `${color}|${len}|${wid}|${tall}`;
  let s = standinCache.get(key);
  if (!s) {
    const g = new THREE.Group();
    // one roughness/metalness for every part so the bake gives a single mesh (one draw call per stand-in)
    const body = mat(color, { rough: 0.5, metal: 0.3 });
    const black = mat('#111', { rough: 0.5, metal: 0.3 });
    const h = tall ? 1.85 : 1.45;
    const L = len / 2, y0 = 0.3, yb = y0 + h * (tall ? 0.42 : 0.38), yr = h;
    // lower body: rounded-off nose and tail, the hood and boot falling slightly to the ends
    const lower = new THREE.Mesh(profile([[-L, y0 + 0.08], [-L + 0.06, y0], [L - 0.06, y0], [L, y0 + 0.08], [L, yb - 0.06], [L - 0.2, yb], [-L + 0.3, yb], [-L, yb - 0.1]], wid), body);
    g.add(lower);
    // cabin: raked windshield and rear glass (SUVs and vans: upright, roof to the tail)
    const wf = tall ? -L + len * 0.3 : -L + len * 0.3, rf = tall ? -L + len * 0.42 : -L + len * 0.47;
    const rr = tall ? L - 0.12 : L - len * 0.24, wr = tall ? L - 0.06 : L - len * 0.1;
    g.add(new THREE.Mesh(profile([[wf, yb], [wr, yb], [rr, yr - 0.06], [rf, yr - 0.06]], wid * 0.9), M2.glass));
    g.add(new THREE.Mesh(profile([[rf - 0.03, yr - 0.07], [rr + 0.03, yr - 0.07], [rr - 0.02, yr], [rf + 0.02, yr]], wid * 0.86), body));
    // pillars between windows, in the paint colour
    for (const z of [rf + (rr - rf) * 0.5]) B(g, body, wid * 0.91, yr - yb - 0.06, 0.08, 0, yb, z);
    for (const z of [-len * 0.31, len * 0.31])
      for (const x of [-wid / 2 + 0.12, wid / 2 - 0.12]) {
        const t = C(g, black, 0.34, 0.24, x, 0, z, false);
        t.rotation.z = Math.PI / 2;
        t.position.y = 0.34;
      }
    s = bake(g);
    s.traverse((o) => (o.castShadow = false)); // a stand-in for a few seconds: not worth the shadow cascades
    standinCache.set(key, s);
  }
  const c = s.clone();
  c.userData.standin = true;
  c.traverse((o) => (o.userData.owned = false));
  return c;
}
const M2 = { glass: mat('#1e2a33', { rough: 0.5, metal: 0.3 }) };

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
  /** lateral position of the lane centre (x for avenues, z for streets); eases toward lineTo when changing lanes */
  line: number;
  lineTo: number;
  t: number;
  v: number;
  vmax: number;
  len: number;
  wid: number;
  rect: Rect;
  /** which road this car keeps to when it is recycled: avenue (axis z) or street, offset from the player's */
  slot: { axis: 'x' | 'z'; k: number };
  kind: VehicleKind;
  /** a double-parked delivery truck: stands still in the kerb-side lane with its hazards on */
  parked?: boolean;
}

/**
 * How many vehicles keep to which road around the player. Midtown avenues are packed (three lanes of queues and
 * platoons released by the signals), side avenues less, cross streets carry a trickle.
 */
const SLOTS: { axis: 'x' | 'z'; k: number; n: number }[] = [
  { axis: 'z', k: 0, n: 72 },
  { axis: 'z', k: -1, n: 12 },
  { axis: 'z', k: 1, n: 12 },
  { axis: 'x', k: -2, n: 3 },
  { axis: 'x', k: -1, n: 4 },
  { axis: 'x', k: 0, n: 4 },
  { axis: 'x', k: 1, n: 4 },
  { axis: 'x', k: 2, n: 3 },
];
/** avenue lanes (offset from the centre line): three moving lanes between the two parking lanes */
const AVE_LANES = [-3.6, 0, 3.6];
/** how far ahead/behind the player traffic is simulated (m) */
const RANGE = 200;

export class Traffic {
  cars: Car[] = [];
  portals: Portal[] = [];
  private rng: Rng;
  private warm = false;
  constructor(private group: THREE.Group, seed: number) {
    this.rng = new Rng(hashN(seed, 404));
    group.add(fleetInstances.root); // mid/far LODs of every fleet car (parked and moving) in this level
  }
  rects() {
    return this.cars.map((c) => c.rect);
  }
  private spawn(slot: Car['slot'], p: THREE.Vector3, parked = false) {
    const r = this.rng;
    const ave = slot.axis === 'z';
    const kind: VehicleKind = parked
      ? 'truck'
      : r.chance(ave ? 0.05 : 0.02)
        ? 'bus'
        : r.chance(0.06)
          ? 'truck'
          : r.chance(ave ? 0.42 : 0.3)
            ? 'cab'
            : 'sedan';
    const obj = carMesh(kind, r);
    obj.userData.spin = !parked; // moving traffic shows its four spinning wheels (parked cars one merged mesh)
    this.group.add(obj);
    const c: Car = {
      obj, axis: slot.axis, dir: 1, line: 0, lineTo: 0, t: 0, v: 0, vmax: parked ? 0 : r.range(ave ? 8.5 : 6.5, ave ? 12.5 : 10),
      len: obj.userData.len ?? 4.8, wid: obj.userData.wid ?? 1.9, rect: { minX: 0, minZ: 0, maxX: 0, maxZ: 0 }, slot, kind, parked,
    };
    this.place(c, p, true);
    this.cars.push(c);
  }
  /** put a car on its road: anywhere in range at start, upstream of the player when recycled */
  private place(c: Car, p: THREE.Vector3, initial = false) {
    const r = this.rng;
    if (c.axis === 'z') {
      const k = Math.round(p.x / AX - 0.5) + c.slot.k;
      c.dir = k % 2 === 0 ? -1 : 1; // one-way avenues alternate
      // buses and double-parked trucks keep to the kerb-side lanes
      const lanes = c.parked || c.kind === 'bus' ? [AVE_LANES[0], AVE_LANES[2]] : AVE_LANES;
      c.line = (k + 0.5) * AX + r.pick(lanes);
      // at start mostly downstream of the player (in view when looking along the traffic), later fed from upstream
      c.t = p.z - c.dir * (initial ? r.range(-RANGE * 0.95, RANGE * 0.35) : r.range(RANGE * 0.7, RANGE * 0.95));
    } else {
      const k = Math.round(p.z / SZ - 0.5) + c.slot.k;
      c.dir = k % 2 === 0 ? 1 : -1;
      c.line = (k + 0.5) * SZ;
      c.t = p.x - c.dir * (initial ? r.range(-RANGE * 0.8, RANGE * 0.8) : r.range(RANGE * 0.6, RANGE * 0.9));
    }
    c.lineTo = c.line;
    // [districts] roads end at parks, the airport and the river: start on a road that is there
    for (let i = 0; i < 8 && !laneOpen(c.axis, c.line, c.t); i++) c.t += c.dir * SZ;
    // double-parked trucks stand clear of intersections (mid-block)
    if (c.parked) {
      const P = c.axis === 'z' ? SZ : AX;
      const mid = (Math.round(c.t / P - 0.5) + 0.5) * P + P / 2;
      c.t = mid + r.range(-P * 0.25, P * 0.25);
    }
    // never drop a car onto (or right behind) one already in that lane: back off until there is a gap
    for (let i = 0; i < 30; i++) {
      const hit = this.cars.find((o) => o !== c && o.axis === c.axis && Math.abs(o.line - c.line) <= 1.2 && Math.abs(o.t - c.t) < (o.len + c.len) / 2 + 3);
      if (!hit) break;
      c.t = hit.t - c.dir * ((hit.len + c.len) / 2 + 3 + r.range(0, 4));
    }
    c.v = c.parked ? 0 : c.vmax * (initial ? 0.6 : 1);
    // not so fast that it could not stop for the next signal from here
    if (!c.parked) {
      const period = c.axis === 'z' ? SZ : AX, half = c.axis === 'z' ? ST / 2 : AVE / 2;
      const front = c.t + (c.dir * c.len) / 2;
      const k = c.dir > 0 ? Math.floor((front + half) / period - 0.5) + 1 : Math.ceil((front - half) / period - 0.5) - 1;
      const dist = ((k + 0.5) * period - c.dir * (half + 4.2) - front) * c.dir;
      if (dist < 30) c.v = Math.min(c.v, Math.max(0, dist - 1) * 0.4);
    }
    c.obj.rotation.y = c.axis === 'z' ? (c.dir > 0 ? Math.PI : 0) : c.dir > 0 ? -Math.PI / 2 : Math.PI / 2;
  }
  update(dt: number, p: THREE.Vector3, time: number) {
    if (!this.cars.length) {
      for (const s of SLOTS) for (let i = 0; i < s.n; i++) this.spawn({ axis: s.axis, k: s.k }, p);
      // one or two delivery trucks double-parked on the player's avenue
      for (let i = 0; i < 2; i++) this.spawn({ axis: 'z', k: 0 }, p, true);
    }
    if (!this.warm) {
      // settle 40 s of traffic before the first frame, so queues and platoons are already there at load
      this.warm = true;
      for (let s = 0; s < 160; s++) this.step(0.25, p, time - 40 + s * 0.25);
    }
    this.step(dt, p, time);
    // near LODs on, everything else into the instance batches (parked cars of every chunk included)
    fleetInstances.update(p);
  }
  private laneFree(c: Car, line: number) {
    for (const o of this.cars) {
      if (o === c || o.axis !== c.axis || (Math.abs(o.line - line) > 1.5 && Math.abs(o.lineTo - line) > 1.5)) continue;
      // room ahead, and behind enough for whoever comes up that lane to brake
      const behind = (c.t - o.t) * c.dir > 0;
      if (Math.abs(o.t - c.t) < (o.len + c.len) / 2 + 4 + (behind ? o.v * 1.2 : 0)) return false;
    }
    return true;
  }
  private step(dt: number, p: THREE.Vector3, time: number) {
    for (const c of this.cars) {
      const along = c.axis === 'x' ? p.x : p.z;
      const across = c.axis === 'x' ? p.z : p.x;
      // (recycle well beyond the placement range: a crowded upstream backs new cars off past it)
      if (Math.abs(c.t - along) > RANGE * 1.3 || Math.abs(c.line - across) > 260) this.place(c, p);
      const x0 = c.axis === 'x' ? c.t : c.line, z0 = c.axis === 'x' ? c.line : c.t;
      if (c.parked) {
        c.obj.userData.braking = Math.floor(time * 1.6) % 2 === 0; // hazard flashers
        this.finish(c, x0, z0);
        continue;
      }
      let target = c.vmax;
      // follow the car ahead in the same lane (or in the lane it is moving into)
      let blocker: Car | null = null;
      let leadGap = 1e9;
      for (const o of this.cars) {
        if (o === c || o.axis !== c.axis || o.dir !== c.dir) continue;
        if (Math.abs(o.line - c.line) > 1.6 && Math.abs(o.line - c.lineTo) > 1.6 && Math.abs(o.lineTo - c.line) > 1.6) continue;
        const ahead = (o.t - c.t) * c.dir;
        // o is ahead (ties broken by order) — also when they already overlap, so the rear one waits
        if (ahead < 0 || (ahead === 0 && this.cars.indexOf(o) > this.cars.indexOf(c))) continue;
        const gap = ahead - (o.len + c.len) / 2;
        leadGap = Math.min(leadGap, gap);
        if (gap < 30) {
          // ~1 s headway with 2.5 m standstill spacing, so platoons keep moving at speed
          const tg = Math.max(0, gap - 2.5);
          if (tg < target) {
            target = tg;
            blocker = o;
          }
        }
      }
      // red light: stop before the next intersection
      const period = c.axis === 'z' ? SZ : AX;
      const halfCross = c.axis === 'z' ? ST / 2 : AVE / 2;
      const front = c.t + (c.dir * c.len) / 2;
      // the next intersection is the first whose near edge is still ahead of the front bumper, so a car that
      // overshoots its stop line keeps stopping for this intersection instead of retargeting the next one
      const k = c.dir > 0 ? Math.floor((front + halfCross) / period - 0.5) + 1 : Math.ceil((front - halfCross) / period - 0.5) - 1;
      const centre = (k + 0.5) * period;
      const stopAt = centre - c.dir * (halfCross + 4.2);
      const dist = (stopAt - front) * c.dir;
      const light = lightFor(c.axis, time);
      // red: always stop (hard if already past the line); yellow: stop if there is room to (~4 m/s²), else clear
      // (going on yellow only if the front reaches the box before the red)
      const ph = ((time % CYCLE) + CYCLE) % CYCLE;
      const yellowLeft = (c.axis === 'z' ? SIGNAL.aveRed : SIGNAL.stRed) - ph;
      // (and only with a clear road ahead: a follower slowed by its leader would reach the box on red)
      const stop = light === 'r' || (light === 'y' && (dist > (c.v * c.v) / 8 - 1 || (dist + 4.2) / Math.max(c.v, 0.1) > yellowLeft - 0.7 || leadGap < 15));
      if (stop && dist < 30) target = Math.min(target, Math.max(0, (dist - 0.5) * 1.2));
      // [districts] a dead end ahead (park, airport, river): stop there; vanish once out of sight range
      {
        const ahead = c.t + c.dir * (c.len / 2 + 6);
        if (!laneOpen(c.axis, c.line, ahead)) {
          if (Math.hypot(c.obj.position.x - p.x, c.obj.position.z - p.z) > 90) this.place(c, p);
          else target = 0;
        }
      }
      // stuck behind a double-parked truck: move over a lane when there is room
      if (blocker?.parked && c.axis === 'z' && c.line === c.lineTo) {
        const centreLine = (Math.round(c.line / AX - 0.5) + 0.5) * AX;
        const inner = c.line - Math.sign(c.line - centreLine) * 3.6;
        if (this.laneFree(c, inner)) c.lineTo = inner;
      }
      if (c.line !== c.lineTo) {
        const d = c.lineTo - c.line;
        c.line += Math.sign(d) * Math.min(Math.abs(d), dt * 1.4);
      }
      // don't run the player over
      const pg = (along - c.t) * c.dir - c.len / 2;
      if (Math.abs(across - c.line) < c.wid && pg > -1 && pg < 12) target = 0;
      const brake = c.obj.userData.brake as THREE.Object3D | undefined;
      const braking = target < c.v - 0.3 || c.v < 0.5;
      c.obj.userData.braking = braking; // brake-light glow cards (FleetInstances)
      if (brake) brake.visible = braking;
      c.v += (target - c.v) * Math.min(1, dt * (target < c.v ? 4 : 1.2));
      c.t += c.dir * c.v * dt;
      const x = c.axis === 'x' ? c.t : c.line, z = c.axis === 'x' ? c.line : c.t;
      const wheels = c.obj.userData.wheels as THREE.Object3D[] | undefined;
      if (wheels) for (const w of wheels) w.rotation.x -= (c.v * dt) / c.obj.userData.wheelR;
      this.finish(c, x, z);
    }
  }
  private finish(c: Car, x: number, z: number) {
    c.obj.position.set(x, 0, z);
    const hx = (c.axis === 'x' ? c.len : c.wid) / 2, hz = (c.axis === 'x' ? c.wid : c.len) / 2;
    c.rect.minX = x - hx; c.rect.maxX = x + hx; c.rect.minZ = z - hz; c.rect.maxZ = z + hz;
  }
}
