import * as THREE from 'three';
import { Rng } from '../rng';
import { mat, glow } from '../build';
import { signTex } from '../textures';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { B, C, M, SIG, CURB, unitSphere, streetName, canvasTex } from './common';
import { addTree, SPECIES, TREE_VARIANTS, type Species } from './streettrees';
import { streetLightMarker } from '../lighting';

/** Street furniture: signals, name signs, lamp posts, trees, hydrants, subway entrances. */
export function signalPole(parent: THREE.Object3D, x: number, z: number, sx: number, sz: number) {
  const pole = M.pole();
  C(parent, pole, 0.1, 4.6, x, CURB, z);
  const head = (axis: 'x' | 'z', y: number) => {
    const g = new THREE.Group();
    B(g, mat('#e0b21a', { rough: 0.6 }), 0.36, 1.05, 0.3, 0, 0, 0);
    const [R, Y, G] = axis === 'z' ? [SIG.aveR, SIG.aveY, SIG.aveG] : [SIG.stR, SIG.stY, SIG.stG];
    const lamp = (m: THREE.Material, yy: number) => {
      const s = new THREE.Mesh(unitSphere, m);
      s.scale.set(0.22, 0.22, 0.08);
      s.position.set(0, yy, 0.16);
      g.add(s);
    };
    lamp(R, 0.85);
    lamp(Y, 0.53);
    lamp(G, 0.21);
    // face the approaching traffic of this axis
    g.rotation.y = axis === 'z' ? (sz > 0 ? 0 : Math.PI) : sx > 0 ? Math.PI / 2 : -Math.PI / 2;
    g.position.set(x + (axis === 'x' ? 0 : -sx * 0.25), y, z + (axis === 'z' ? 0 : -sz * 0.25));
    parent.add(g);
  };
  head('z', 3.4);
  head('x', 3.4);
  // pedestrian signal
  B(parent, mat('#1a1a1a'), 0.3, 0.32, 0.22, x, 2.3, z - sz * 0.2, false);
}

export const nameSignCache = new Map<string, THREE.MeshStandardMaterial>();
export function nameSign(text: string, x: number, y: number, z: number, rotY: number) {
  let m = nameSignCache.get(text);
  if (!m) {
    const t = signTex(text, '#0d6b3a', '#ffffff');
    m = new THREE.MeshStandardMaterial({ map: t, roughness: 0.4, side: THREE.DoubleSide });
    nameSignCache.set(text, m);
  }
  const g = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.36), m);
  g.userData.owned = true;
  g.position.set(x, y, z);
  g.rotation.y = rotY;
  return g;
}

export function lampPost(parent: THREE.Object3D, group: THREE.Group, x: number, z: number, axis: 'x' | 'z', side: number) {
  const pole = M.pole();
  C(parent, pole, 0.13, 0.9, x, CURB, z);
  C(parent, pole, 0.08, 8.2, x, CURB, z);
  // arm reaching over the road
  const ax = axis === 'z' ? side * 1.6 : 0, az = axis === 'x' ? side * 1.6 : 0;
  const arm = B(parent, pole, axis === 'z' ? 3.2 : 0.1, 0.1, axis === 'x' ? 3.2 : 0.1, x + ax / 2 + (axis === 'z' ? side * 0.8 : 0), 8.2, z + az / 2 + (axis === 'x' ? side * 0.8 : 0));
  void arm;
  const hx = x + (axis === 'z' ? side * 3.0 : 0), hz = z + (axis === 'x' ? side * 3.0 : 0);
  B(parent, mat('#5a5f5a', { metal: 0.4, rough: 0.5 }), axis === 'z' ? 0.9 : 0.4, 0.22, axis === 'x' ? 0.9 : 0.4, hx, 8.05, hz);
  B(parent, mat('#fff3d8', { emissive: '#ffe2b0', ei: 1 }), axis === 'z' ? 0.7 : 0.3, 0.04, axis === 'x' ? 0.7 : 0.3, hx, 8.02, hz, false);
  group.add(streetLightMarker(hx, 7.9, hz)); // lighting.ts lights it at night
}

// ---------------------------------------------------------------- shared prop helpers

const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3();
/** add a mesh of a shared geometry with position / yaw (and optional pitch/roll, scale) — baked later */
export function put(parent: THREE.Object3D, geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, ry = 0, shadow = true, rx = 0, rz = 0, sc: number | [number, number, number] = 1) {
  const o = new THREE.Mesh(geo, m);
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  if (typeof sc === 'number') _s.setScalar(sc);
  else _s.set(...sc);
  o.matrixAutoUpdate = false;
  o.matrix.compose(_v.set(x, y, z), _q, _s);
  o.castShadow = shadow;
  parent.add(o);
  return o;
}
/** child transform helper: run `fn` with a group placed at (x,y,z,ry); everything added to it is baked in place */
export function at(parent: THREE.Object3D, x: number, y: number, z: number, ry: number, fn: (g: THREE.Group) => void) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  parent.add(g);
  fn(g);
  return g;
}
const geoCache = new Map<string, THREE.BufferGeometry>();
export function cachedGeo(key: string, make: () => THREE.BufferGeometry) {
  let g = geoCache.get(key);
  if (!g) {
    g = make();
    geoCache.set(key, g);
  }
  return g;
}
/** LatheGeometry from a [radius, y] profile */
export function lathe(key: string, prof: [number, number][], seg = 16) {
  return cachedGeo(`lathe:${key}`, () => new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), seg));
}
export function rbox(key: string, w: number, h: number, d: number, r: number, seg = 2) {
  return cachedGeo(`rbox:${key}`, () => {
    const g = new RoundedBoxGeometry(w, h, d, seg, r);
    g.translate(0, h / 2, 0);
    return g;
  });
}
export function cyl(key: string, rt: number, rb: number, h: number, seg = 12, open = false) {
  return cachedGeo(`cyl:${key}`, () => {
    const g = new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);
    g.translate(0, h / 2, 0);
    return g;
  });
}
/** tube along a polyline/curve */
export function tube(key: string, pts: THREE.Vector3[], r: number, tubular = 24, radial = 8) {
  return cachedGeo(`tube:${key}`, () => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.2), tubular, r, radial, false));
}

/** painted / galvanised metals shared by all street furniture */
export const PM = {
  black: () => mat('#17181a', { rough: 0.45, metal: 0.55 }),
  galv: () => mat('#8d9192', { rough: 0.42, metal: 0.85 }),
  galvDark: () => mat('#5f6466', { rough: 0.5, metal: 0.8 }),
  dotGreen: () => mat('#1f4a33', { rough: 0.5, metal: 0.4 }),
  signalYellow: () => mat('#e6b414', { rough: 0.5, metal: 0.15 }),
  signalBlack: () => mat('#141516', { rough: 0.55, metal: 0.2 }),
  granite: () => mat('#9b968d', { rough: 0.85 }),
  concrete: () => mat('#a39f97', { rough: 0.95 }),
};

// ---------------------------------------------------------------- street trees

/** soil + mulch texture for tree pits */
let soilMat: THREE.MeshStandardMaterial | null = null;
function pitSoil() {
  if (soilMat) return soilMat;
  const t = canvasTex(256, 256, (g) => {
    g.fillStyle = '#3a2e24';
    g.fillRect(0, 0, 256, 256);
    const r = new Rng(9);
    for (let i = 0; i < 1600; i++) {
      g.fillStyle = r.pick(['#2a211a', '#4a3a2c', '#5b4733', '#6b5238', '#26201b', '#3f4a2a']);
      g.save();
      g.translate(r.range(0, 256), r.range(0, 256));
      g.rotate(r.range(0, 6.28));
      g.fillRect(-r.range(2, 7), -1, r.range(4, 14), r.range(1.5, 3));
      g.restore();
    }
    // a few weeds / dead leaves
    for (let i = 0; i < 60; i++) {
      g.fillStyle = r.pick(['#4f6a2c', '#6b7a34', '#8a6a3a']);
      g.beginPath();
      g.ellipse(r.range(0, 256), r.range(0, 256), r.range(2, 5), r.range(1, 2.5), r.range(0, 3), 0, 6.28);
      g.fill();
    }
  }, true);
  soilMat = new THREE.MeshStandardMaterial({ map: t, roughness: 1 });
  return soilMat;
}

/** NYC tree guard: black steel, 18 in high, top rail with hairpin loops and pickets */
function guardGeo(L: number, W: number) {
  return cachedGeo(`guard:${L}x${W}`, () => {
    const parts: THREE.BufferGeometry[] = [];
    const H = 0.46;
    const add = (g: THREE.BufferGeometry, x: number, y: number, z: number, ry = 0) => {
      g.rotateY(ry);
      g.translate(x, y, z);
      parts.push(g.index ? g.toNonIndexed() : g);
    };
    const sides: [number, number, number, number][] = [
      [0, -W / 2, L, 0], [0, W / 2, L, 0], [-L / 2, 0, W, Math.PI / 2], [L / 2, 0, W, Math.PI / 2],
    ];
    for (const [cx, cz, len, ry] of sides) {
      // top and bottom rails (flat bar)
      add(new THREE.BoxGeometry(len, 0.02, 0.04), cx, H, cz, ry);
      add(new THREE.BoxGeometry(len, 0.035, 0.016), cx, 0.09, cz, ry);
      // hairpin loops hanging from the top rail
      const n = Math.round(len / 0.16);
      for (let i = 0; i < n; i++) {
        const t = -len / 2 + (i + 0.5) * (len / n);
        const loop = new THREE.TorusGeometry(0.06, 0.009, 4, 8, Math.PI);
        loop.rotateZ(Math.PI);
        // legs of the hairpin
        const legs = new THREE.BoxGeometry(0.016, H - 0.09 - 0.06, 0.016);
        const lx = Math.cos(ry) * t, lz = -Math.sin(ry) * t;
        add(loop, cx + lx, H - 0.0, cz + lz, ry);
        const l1 = legs.clone(), l2 = legs;
        add(l1, cx + lx + Math.cos(ry) * 0.06, 0.09 + (H - 0.15) / 2, cz + lz - Math.sin(ry) * 0.06, ry);
        add(l2, cx + lx - Math.cos(ry) * 0.06, 0.09 + (H - 0.15) / 2, cz + lz + Math.sin(ry) * 0.06, ry);
      }
    }
    // corner posts with ball finials, driven into the soil
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      add(new THREE.BoxGeometry(0.04, H + 0.02, 0.04), (sx * L) / 2, (H + 0.02) / 2, (sz * W) / 2);
      add(new THREE.SphereGeometry(0.028, 8, 6), (sx * L) / 2, H + 0.04, (sz * W) / 2);
    }
    for (const p of parts) for (const k of Object.keys(p.attributes)) if (!['position', 'normal', 'uv'].includes(k)) p.deleteAttribute(k);
    return mergeGeometries(parts, false)!;
  });
}

/**
 * A street tree in its pit: granite-edged soil pit along the kerb, an optional steel guard, and an
 * instanced procedural tree (per-chunk LOD) added to `group`.
 */
export function tree(stat: THREE.Object3D, x: number, z: number, rng: Rng, group: THREE.Object3D, axis: 'x' | 'z' = 'x', species?: Species) {
  const ry = axis === 'x' ? 0 : Math.PI / 2;
  const L = 2.4, W = 1.2;
  at(stat, x, CURB, z, ry, (g) => {
    // pit soil, slightly sunk, with a raised granite / concrete edge
    put(g, cachedGeo('pitSoil', () => {
      const p = new THREE.PlaneGeometry(L, W);
      p.rotateX(-Math.PI / 2);
      const uv = p.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * L, uv.getY(i) * W);
      return p;
    }), pitSoil(), 0, 0.012, 0, 0, false);
    const edge = PM.granite();
    put(g, rbox('pitEdgeL', L + 0.2, 0.05, 0.1, 0.012), edge, 0, -0.01, W / 2 + 0.05, 0, false);
    put(g, rbox('pitEdgeL', L + 0.2, 0.05, 0.1, 0.012), edge, 0, -0.01, -W / 2 - 0.05, 0, false);
    put(g, rbox('pitEdgeW', 0.1, 0.05, W, 0.012), edge, L / 2 + 0.05, -0.01, 0, 0, false);
    put(g, rbox('pitEdgeW', 0.1, 0.05, W, 0.012), edge, -L / 2 - 0.05, -0.01, 0, 0, false);
    if (rng.chance(0.6)) put(g, guardGeo(L, W), PM.black(), 0, 0, 0, 0, true);
  });
  // block-dominant species, the odd one different
  let sp = species;
  if (!sp) {
    group.userData.treeSpecies ??= rng.pick(['plane', 'plane', 'plane', 'locust', 'locust', 'pear'] as Species[]);
    group.userData.treeVariant ??= rng.int(0, TREE_VARIANTS - 1);
    sp = rng.chance(0.85) ? group.userData.treeSpecies : rng.pick(SPECIES);
  }
  addTree(group, sp!, sp === group.userData.treeSpecies ? group.userData.treeVariant ?? 0 : 0, x + (axis === 'x' ? rng.range(-0.3, 0.3) : 0), CURB + 0.01, z + (axis === 'z' ? rng.range(-0.3, 0.3) : 0), rng);
}

export function hydrant(parent: THREE.Object3D, x: number, z: number) {
  const m = mat(Math.abs(x + z) % 2 < 1 ? '#c4161c' : '#e0b21a', { rough: 0.5 });
  C(parent, m, 0.16, 0.65, x, CURB, z);
  C(parent, m, 0.2, 0.08, x, CURB + 0.65, z);
  const top = new THREE.Mesh(unitSphere, m);
  top.scale.setScalar(0.3);
  top.position.set(x, CURB + 0.76, z);
  parent.add(top);
  B(parent, m, 0.5, 0.1, 0.1, x, CURB + 0.42, z);
}

export function subway(parent: THREE.Object3D, group: THREE.Group, x: number, z: number, cz: number, rng: Rng) {
  const rail = mat('#1f4a2e', { metal: 0.5, rough: 0.5 });
  const w = 2.0, l = 5.0;
  // railings around a stair opening
  B(parent, rail, 0.06, 1.0, l, x - w / 2, CURB, z);
  B(parent, rail, 0.06, 1.0, l, x + w / 2, CURB, z);
  B(parent, rail, w, 1.0, 0.06, x, CURB, z - Math.sign(z) * l / 2);
  B(parent, mat('#0b0b0b'), w - 0.1, 0.02, l - 0.4, x, CURB + 0.005, z);
  for (let k = 0; k < 7; k++) B(parent, mat('#555'), w - 0.15, 0.04, 0.35, x, CURB - k * 0.02, z + Math.sign(z) * (l / 2 - 0.5 - k * 0.55), false);
  for (const sx of [-1, 1]) {
    C(parent, rail, 0.05, 2.3, x + (sx * w) / 2, CURB, z + Math.sign(z) * l / 2);
    const globe = new THREE.Mesh(unitSphere, mat('#6fe08a', { emissive: '#3aff7a', ei: 1.2 }));
    globe.scale.setScalar(0.32);
    globe.position.set(x + (sx * w) / 2, CURB + 2.45, z + Math.sign(z) * l / 2);
    parent.add(globe);
    group.add(glow('#5aff8a', 1.2, globe.position.x, globe.position.y, globe.position.z, 0.5));
  }
  const lines = rng.pick(['1 2 3', 'A C E', 'N Q R W', '4 5 6', 'B D F M', 'L']);
  const s = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.4), new THREE.MeshStandardMaterial({ map: signTex(`${streetName(cz)} · ${lines}`, '#111111', '#ffffff'), side: THREE.DoubleSide }));
  s.userData.owned = true;
  s.position.set(x, CURB + 1.3, z + Math.sign(z) * l / 2);
  group.add(s);
}

// ---------------------------------------------------------------- vehicles

