import * as THREE from 'three';
import { B, C, M, canvasTex, unitSphere } from './common';
import { mat } from '../build';
import type { Rng } from '../rng';
import type { Face } from './buildings';

/**
 * [nbhd] Brownstone rows (docs/research/neighborhood-audit.md, Brownstone Row): what makes a Park Slope /
 * Brooklyn Heights / Harlem / Upper West Side row read as brownstone and not as red brick:
 *  - smooth chocolate-brown sandstone ashlar (fine joints, weathered, no brick coursing), rusticated base;
 *  - rows built by one developer: 3–8 houses of the same width, storeys, parlour height, cornice line and colour;
 *  - stoops with heavy cast-iron newel posts and sunburst ironwork, a garden-level entrance under the stoop,
 *    heavy door hoods on scrolled consoles with a pediment, planted front areaways behind low iron fences.
 * Pure helpers: buildings.ts calls them from the brownstone branch; nyc.ts / the lab pick runs with brownRun().
 */

/** brownstone colours: chocolate to the pinker Harlem / Park Slope stone */
export const BROWN_WALLS = ['#6a4636', '#6b4a3a', '#76533f', '#7f5a46', '#8a634e', '#94695a', '#7a5040'];

/** storeys above the garden level (parlour floor + 2..3 bedroom floors): 3 or 4; with the garden level 4–5 */
export const BROWN_FLOORS: [number, number] = [3, 4];

/** mean of the ashlar canvas (neutral light stone): the tint is the wall colour divided by it */
const ASHLAR_MEAN = 0.8;
/** UV tile of the facade quads (metres per UV unit, buildings.ts TILE) and the canvas's extent (m) */
const TILE: [number, number] = [12, 12.8];
const SPAN = 4;

let ashlar: THREE.MeshStandardMaterial | null = null;
/**
 * Smooth brownstone ashlar: courses of 0.5 m, blocks 0.9–1.8 m with hairline joints, per-block tone,
 * weathering blotches and rain streaks. Neutral light grey so the vertex tint gives the stone's colour.
 */
export function brownstoneMat() {
  if (ashlar) return ashlar;
  const W = 512, px = W / SPAN;
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const t = canvasTex(W, W, (g) => {
    const base = Math.round(ASHLAR_MEAN * 255);
    g.fillStyle = `rgb(${base},${base},${base})`;
    g.fillRect(0, 0, W, W);
    const course = 0.5 * px;
    for (let row = 0; row < W / course; row++) {
      let x = -rnd() * 1.4 * px;
      while (x < W) {
        const bw = (0.9 + rnd() * 0.9) * px;
        const v = base + (rnd() - 0.5) * 16;
        const warm = (rnd() - 0.5) * 6;
        g.fillStyle = `rgb(${Math.round(v + warm)},${Math.round(v)},${Math.round(v - warm)})`;
        g.fillRect(x + 1, row * course + 1, bw - 2, course - 2);
        // a darker weathered patch on some blocks (spalled face)
        if (rnd() < 0.25) {
          g.fillStyle = `rgba(60,50,45,${0.05 + rnd() * 0.08})`;
          g.beginPath();
          g.ellipse(x + bw * rnd(), row * course + course * rnd(), bw * (0.1 + rnd() * 0.25), course * (0.15 + rnd() * 0.3), 0, 0, Math.PI * 2);
          g.fill();
        }
        // hairline joints
        g.fillStyle = 'rgba(70,62,58,0.55)';
        g.fillRect(x, row * course, 1.5, course);
        x += bw;
      }
      g.fillStyle = 'rgba(70,62,58,0.6)';
      g.fillRect(0, row * course, W, 1.5);
    }
    // rain streaks
    for (let i = 0; i < 60; i++) {
      g.fillStyle = `rgba(40,34,30,${0.03 + rnd() * 0.05})`;
      g.fillRect(rnd() * W, rnd() * W, 1 + rnd() * 3, 20 + rnd() * 120);
    }
    // fine grain
    const img = g.getImageData(0, 0, W, W);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (rnd() - 0.5) * 14;
      img.data[i] += n;
      img.data[i + 1] += n;
      img.data[i + 2] += n;
    }
    g.putImageData(img, 0, 0);
  }, true);
  t.repeat.set(TILE[0] / SPAN, TILE[1] / SPAN);
  ashlar = new THREE.MeshStandardMaterial({ map: t, vertexColors: true, roughness: 0.88, envMapIntensity: 0.4 });
  ashlar.name = 'brownstone-ashlar';
  ashlar.userData.pbr = true; // bake(): own bucket; Face.band() gives it metre UVs and the tint
  return ashlar;
}

/** vertex tint that lands the ashlar canvas on the wall colour */
export function brownTint(wall: string) {
  const c = new THREE.Color(wall).multiplyScalar(1 / ASHLAR_MEAN);
  c.r = Math.min(1, c.r);
  c.g = Math.min(1, c.g);
  c.b = Math.min(1, c.b);
  return `#${c.getHexString()}`;
}

/** one developer's run of identical houses */
export interface BrownRun {
  left: number;
  w: number;
  floors: number;
  parlor: number;
  wall: string;
  cornicePaint: string;
  bow: boolean;
}
/** the next brownstone of a row: continue the run, or start a new one (3–7 houses) */
export function brownRun(rng: Rng, prev: BrownRun | null): BrownRun {
  if (prev && prev.left > 0) {
    prev.left--;
    return prev;
  }
  const run: BrownRun = {
    left: rng.int(2, 6),
    w: rng.range(5.6, 6.8),
    floors: rng.int(BROWN_FLOORS[0], BROWN_FLOORS[1]),
    parlor: rng.range(1.45, 1.7),
    wall: rng.pick(BROWN_WALLS),
    cornicePaint: rng.pick(['#3a2a20', '#2a2420', '#4a3a2e', '#33291f']),
    bow: rng.chance(0.35),
  };
  return run;
}

/** a box with metre UVs (like buildings.ts PB) in the ashlar, tinted */
function SB(parent: THREE.Object3D, w: number, h: number, d: number, x: number, y: number, z: number, tint: string, shadow = true) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++)
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, (uv.getX(i) * dims[f][0]) / TILE[0], (uv.getY(i) * dims[f][1]) / TILE[1]);
    }
  const o = new THREE.Mesh(g, brownstoneMat());
  o.position.set(x, y + h / 2, z);
  o.castShadow = shadow;
  o.userData.tint = tint;
  parent.add(o);
  return o;
}

let sunGeo: THREE.BufferGeometry | null = null;
/** a cast-iron sunburst: ring with spokes (one shared geometry) */
function sunburst() {
  if (sunGeo) return sunGeo;
  const parts: THREE.BufferGeometry[] = [new THREE.TorusGeometry(0.17, 0.012, 4, 16).toNonIndexed(), new THREE.TorusGeometry(0.05, 0.012, 4, 8).toNonIndexed()];
  for (let i = 0; i < 8; i++) {
    const b = new THREE.BoxGeometry(0.012, 0.12, 0.012).toNonIndexed();
    b.translate(0, 0.11, 0);
    b.rotateZ((i / 8) * Math.PI * 2);
    parts.push(b);
  }
  for (const p of parts) for (const k of Object.keys(p.attributes)) if (!['position', 'normal'].includes(k)) p.deleteAttribute(k);
  const pos: number[] = [], nor: number[] = [];
  for (const p of parts) {
    pos.push(...(p.getAttribute('position').array as Float32Array));
    nor.push(...(p.getAttribute('normal').array as Float32Array));
  }
  sunGeo = new THREE.BufferGeometry();
  sunGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  sunGeo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  sunGeo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  return sunGeo;
}

export interface FaceLike {
  g: THREE.Group;
  f: THREE.Group;
}

/**
 * Stoop dressing: heavy cast-iron newel posts on the cheek-wall ends (plinth, octagonal shaft, cap, urn),
 * sunburst panels in the sloped rails, and the garden-level entrance under the stoop (a dark doorway in the
 * landing's side with an iron gate, opening onto the areaway).
 * uc: the stoop's centre along the face; w: flight width; land: landing depth; run: flight length.
 */
export function stoopDressing(F: FaceLike, uc: number, parlor: number, w: number, land: number, run: number, tint: string, gateSide: 1 | -1) {
  const iron = M.iron();
  for (const s of [-1, 1]) {
    const x = uc + s * (w / 2 + 0.13);
    const zf = land + run + 0.12;
    // newel: plinth on the cheek wall, shaft, cap, urn finial (≈1.2 m over the cheek top)
    B(F.g, iron, 0.3, 0.22, 0.3, x, 0.75, zf);
    C(F.g, iron, 0.1, 0.8, x, 0.97, zf);
    B(F.g, iron, 0.28, 0.08, 0.28, x, 1.77, zf);
    const urn = new THREE.Mesh(unitSphere, iron);
    urn.scale.set(0.22, 0.26, 0.22);
    urn.position.set(x, 1.98, zf);
    F.f.add(urn);
    // sunburst panels in the sloped rail
    for (const t of [0.3, 0.62]) {
      const z = land + run * (1 - t);
      const y = 0.75 + t * (parlor - 0.3) + 0.45;
      const m = new THREE.Mesh(sunburst(), iron);
      m.position.set(x, y, z);
      m.rotation.y = Math.PI / 2;
      F.f.add(m);
    }
  }
  // garden-level door under the stoop: a dark doorway in the landing's side with an iron gate
  const sx = uc + gateSide * ((w + 0.5) / 2 + 0.006);
  const gh = Math.max(0.9, parlor - 0.25);
  B(F.g, mat('#15110e', { rough: 0.9 }), 0.012, gh, 0.62, sx, 0.15, land / 2 + 0.02, false);
  for (let k = 0; k < 6; k++) B(F.f, iron, 0.03, gh, 0.02, sx + gateSide * 0.02, 0.15, land / 2 - 0.27 + k * 0.11, false);
  for (const y of [0.3, 0.15 + gh - 0.12]) B(F.f, iron, 0.03, 0.04, 0.64, sx + gateSide * 0.02, y, land / 2 + 0.02, false);
}

let curlGeo: THREE.CylinderGeometry | null = null;
/**
 * The parlour door's hood: tall scrolled consoles beside the door and a triangular or segmental pediment
 * over doorway()'s entablature (whose top is at y + h + 0.42).
 */
export function doorHood(F: FaceLike, uc: number, y: number, w: number, h: number, tint: string, rng: Rng) {
  for (const s of [-1, 1]) {
    const x = uc + s * (w / 2 + 0.2);
    SB(F.g, 0.24, 0.85, 0.36, x, y + h - 0.6, 0.18, tint);
    // the scroll's curl at the console's foot
    const curl = new THREE.Mesh((curlGeo ??= new THREE.CylinderGeometry(0.1, 0.1, 0.24, 10)), brownstoneMat());
    curl.rotation.z = Math.PI / 2;
    curl.position.set(x, y + h - 0.62, 0.26);
    curl.userData.tint = tint;
    F.f.add(curl);
  }
  const pw = w + 1.1, top = y + h + 0.42;
  if (rng.chance(0.55)) {
    const sh = new THREE.Shape();
    sh.moveTo(-pw / 2, 0);
    sh.lineTo(pw / 2, 0);
    sh.lineTo(0, 0.5);
    sh.closePath();
    const g = new THREE.ExtrudeGeometry(sh, { depth: 0.34, bevelEnabled: false });
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / TILE[0], uv.getY(i) / TILE[1]);
    const o = new THREE.Mesh(g, brownstoneMat());
    o.position.set(uc, top + 0.003, 0.03);
    o.userData.tint = tint;
    o.castShadow = true;
    F.g.add(o);
  } else {
    // segmental: a flat arc of stone
    const g = new THREE.CylinderGeometry(pw * 0.62, pw * 0.62, 0.34, 20, 1, false, -0.9, 1.8);
    g.rotateX(Math.PI / 2);
    g.translate(0, -pw * 0.62 + 0.38, 0.2);
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.1, uv.getY(i) * 0.05);
    const o = new THREE.Mesh(g, brownstoneMat());
    o.position.set(uc, top, 0);
    o.userData.tint = tint;
    o.castShadow = true;
    F.g.add(o);
  }
}

/** planting in the front areaway: a soil bed with clipped shrubs and the odd potted plant */
export function areawayGarden(F: FaceLike, u0: number, u1: number, depth: number, rng: Rng) {
  if (u1 - u0 < 1) return;
  B(F.g, mat('#3b2d22', { rough: 1 }), u1 - u0 - 0.1, 0.2, depth - 0.25, (u0 + u1) / 2, 0.0, depth / 2 + 0.05, false);
  const leaf = [M.leaf(), M.leaf2(), mat('#3d5e2a', { rough: 0.9 })];
  for (let u = u0 + 0.45; u < u1 - 0.3; u += rng.range(0.6, 1.0)) {
    const sh = new THREE.Mesh(unitSphere, rng.pick(leaf));
    const r = rng.range(0.35, 0.6);
    sh.scale.set(r, r * rng.range(0.8, 1.3), r * 0.9);
    sh.position.set(u, 0.2 + r * 0.4, rng.range(0.4, depth - 0.45));
    sh.castShadow = true;
    F.g.add(sh);
  }
}

/**
 * Park Slope bow front (angled three-sided bay) between u0 and u1 of the front face, from the garden level up
 * to yTop (under the main cornice), 0.75 m deep: rusticated to baseTop like the house, the same windows on
 * every level (a wide front facet, a narrow window in each 45° side), a flat lead roof and a small cornice.
 */
export function bowFront(F: Face, u0: number, u1: number, levels: number[], parlor: number, baseTop: number, yTop: number, tint: string, win: Parameters<Face['window']>[4], cornice: string) {
  const D = 0.75, W = u1 - u0;
  if (W - 2 * D < 1.2) return;
  F.cut(u0, u1, 0, yTop);
  const side = D * Math.SQRT2;
  const facets = [
    { f: F.sub(u0 + D / 2, D / 2, -Math.PI / 4, side), n: 1, ww: Math.min(0.7, side - 0.4) },
    { f: F.sub((u0 + u1) / 2, D, 0, W - 2 * D), n: Math.max(1, Math.round((W - 2 * D) / 1.5)), ww: 1.05 },
    { f: F.sub(u1 - D / 2, D / 2, Math.PI / 4, side), n: 1, ww: Math.min(0.7, side - 0.4) },
  ];
  const cm = mat(cornice, { rough: 0.6, metal: 0.15 });
  for (const { f, n, ww } of facets) {
    const cs = Array.from({ length: n }, (_, i) => -f.len / 2 + (f.len * (i + 0.5)) / n);
    levels.forEach((ly, i) => {
      const top = i === levels.length - 1;
      const wy = i === 0 ? ly + 0.45 : ly + 0.75, wh = i === 0 ? 2.55 : top ? 1.6 : 1.95;
      if (wy + wh > yTop - 0.3) return;
      for (const c of cs) f.window(c - ww / 2, wy, ww, wh, win);
    });
    for (const c of cs) f.window(c - ww / 2, 0.3, ww, Math.min(1.05, parlor - 0.55), { ...win, trim: 'flat', ac: 0 });
    f.wall(brownstoneMat(), 0, baseTop, tint, 0.42);
    f.wall(brownstoneMat(), baseTop, yTop, tint);
    f.band(cm, yTop - 0.32, 0.32, 0.2, 0.05);
  }
  // the bay's flat roof
  const sh = new THREE.Shape();
  sh.moveTo(u0, 0);
  sh.lineTo(u0 + D, D);
  sh.lineTo(u1 - D, D);
  sh.lineTo(u1, 0);
  sh.closePath();
  const g = new THREE.ShapeGeometry(sh);
  g.rotateX(Math.PI / 2);
  g.translate(0, yTop - 0.02, 0);
  F.g.add(new THREE.Mesh(g, mat('#3a3633', { rough: 0.9 })));
}
