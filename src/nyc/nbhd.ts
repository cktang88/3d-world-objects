import * as THREE from 'three';
import { SZ, LX, LZ, BX, BZ, CURB, SW, canvasTex, type Side } from './common';
import { rect, overlaps, type Rect } from '../level';
import { Rng, hashN } from '../rng';
import { mat } from '../build';
import { building, type BCtx } from './buildings';
import type { District } from './districts';
import { WaterKit } from './waterfront';
import { addTree } from './streettrees';
import { parkBench, stall } from './district-props';
import { litterBasket, newsstand, bikeDock } from './streetprops';

/**
 * [nbhd] Neighbourhood signatures found missing in the street-level audit (docs/research/neighborhood-audit.md):
 *  - the High Line: the elevated rail park over the Meatpacking / West Chelsea blocks (steel plate girders on
 *    column bents 9 m up, planted deck with concrete plank paths, grasses, birches, benches, picket rails);
 *  - Meatpacking: steel loading-dock canopies over the sidewalk on the low market buildings;
 *  - the Garment District: rolling garment racks (Z-racks) parked along the fronts.
 * Called from district-build.ts districtExtras(); the High Line's strip is kept free of row houses by nyc.ts.
 */

/** the High Line's strip through a block (block-local x), or null: the industrial column by 11 Av */
export function highLine(cx: number, cz: number) {
  if (cx !== 5 || cz < -1 || cz > 3) return null;
  return { x0: -25, x1: -15 };
}
const HL_DECK = 8.6, HL_GIRDER = 6.7;

let plankTex: THREE.Texture | null = null;
/** the High Line's precast concrete planks (long, narrow, joints between; "peel-up" ends into the beds) */
function hlPlankMat() {
  plankTex ??= canvasTex(128, 512, (g) => {
    const r = new Rng(41);
    g.fillStyle = '#6d6a64';
    g.fillRect(0, 0, 128, 512);
    for (let col = 0; col < 8; col++)
      for (let y = -r.range(0, 200); y < 512; ) {
        const len = r.range(120, 260), v = r.int(-10, 10);
        g.fillStyle = `rgb(${178 + v},${174 + v},${166 + v})`;
        g.fillRect(col * 16 + 1, y + 1, 14, len - 2);
        y += len;
      }
  }, true);
  return mat('#ffffff', { rough: 0.9, map: plankTex });
}

function box(parent: THREE.Object3D, m: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number) {
  const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  o.position.set(x, y + h / 2, z);
  o.castShadow = true;
  o.receiveShadow = true;
  parent.add(o);
  return o;
}

/** one block's span of the High Line (deck along z, through the block and over both half-streets) */
export function buildHighLine(ctx: BCtx) {
  const hl = highLine(ctx.cx, ctx.cz);
  if (!hl) return;
  const { stat, group, colliders } = ctx;
  const r = new Rng(hashN(ctx.seed, 4242));
  const kit = new WaterKit();
  const xc = (hl.x0 + hl.x1) / 2, W = hl.x1 - hl.x0, z0 = -SZ / 2, z1 = SZ / 2, L = SZ;
  const steel = mat('#3b4140', { rough: 0.6, metal: 0.4 });
  const steelDk = mat('#2c3130', { rough: 0.65, metal: 0.4 });
  // plate girders along both edges with top and bottom flanges, the deck slab between them
  for (const s of [-1, 1]) {
    const x = xc + s * (W / 2 - 0.25);
    box(stat, steel, 0.3, HL_DECK - 0.35 - HL_GIRDER, L, x, HL_GIRDER, 0);
    box(stat, steelDk, 0.7, 0.1, L, x + s * 0.1, HL_GIRDER - 0.1, 0);
    box(stat, steelDk, 0.75, 0.12, L, x + s * 0.12, HL_DECK - 0.35, 0);
    // vertical stiffeners every 1.6 m on the outer web
    for (let z = z0 + 0.8; z < z1; z += 1.6) kit.post(x + s * 0.2, HL_GIRDER, z, 0.08, HL_DECK - 0.35 - HL_GIRDER, 0.14);
  }
  box(stat, mat('#77736b', { rough: 0.9 }), W - 0.6, 0.35, L, xc, HL_DECK - 0.35, 0);
  // cross beams under the deck
  for (let z = z0 + 1.6; z < z1; z += 3.2) box(stat, steelDk, W - 0.6, 0.45, 0.3, xc, HL_GIRDER, z);
  // column bents inside the block (none in the street): two columns, a cap beam, knee braces
  for (const zb of [-(BZ - 7), BZ - 7]) {
    for (const s of [-1, 1]) {
      const x = xc + s * (W / 2 - 1.1);
      box(stat, steel, 0.55, HL_GIRDER, 0.55, x, 0, zb);
      box(stat, steelDk, 0.9, 0.12, 0.9, x, CURB, zb);
      const brace = box(stat, steel, 0.18, 2.0, 0.18, x - s * 0.55, HL_GIRDER - 1.3, zb);
      brace.rotation.z = s * 0.6;
      colliders.push(rect(x, zb, 0.7, 0.7));
    }
    box(stat, steelDk, W - 0.6, 0.6, 0.7, xc, HL_GIRDER - 0.6, zb);
  }
  // the park on top: a concrete plank path down the middle, planting beds either side, picket rails
  const path = new THREE.Mesh(new THREE.PlaneGeometry(3.2, L).rotateX(-Math.PI / 2), hlPlankMat());
  const uv = path.geometry.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i), uv.getY(i) * (L / 8));
  path.position.set(xc + r.range(-0.6, 0.6), HL_DECK + 0.01, 0);
  path.receiveShadow = true;
  stat.add(path);
  const soil = mat('#4a3b2c', { rough: 1 });
  for (const s of [-1, 1]) {
    const bx0 = xc + s * 1.75, bx1 = xc + s * (W / 2 - 0.35);
    box(stat, soil, Math.abs(bx1 - bx0), 0.3, L, (bx0 + bx1) / 2, HL_DECK, 0);
    // meadow grasses and perennials (instanced tufts)
    for (let z = z0 + 0.3; z < z1; z += 0.45)
      for (let k = 0; k < 2; k++) {
        const x = bx0 + (bx1 - bx0) * r.range(0.1, 0.9);
        kit.tuft(x, HL_DECK + 0.3, z + r.range(-0.2, 0.2), r.range(0.5, 1.1), r.pick(['#8a8a4e', '#a39a5c', '#6f7f45', '#7d6e44', '#9a8f6a']));
      }
    kit.rail('z', xc + s * (W / 2 - 0.12), z0, z1, HL_DECK);
  }
  // birches and sumacs in the beds, benches on the path's edge
  for (let z = z0 + 6; z < z1 - 4; z += r.range(10, 16)) addTree(group, r.pick(['locust', 'pear'] as const), r.int(0, 2), xc + r.pick([-1, 1]) * 3, HL_DECK + 0.3, z, r);
  for (let z = z0 + 10; z < z1 - 6; z += 24) parkBench(stat, xc - 1.2, HL_DECK, z, Math.PI / 2);
  kit.flush(group);
}

/** Meatpacking: steel canopies over the loading docks of the low market buildings */
export function meatCanopies(ctx: BCtx) {
  const r = new Rng(hashN(ctx.seed, 4343));
  const steel = mat('#3a3d3f', { rough: 0.6, metal: 0.35 });
  const fascia = mat('#5a5f60', { rough: 0.55, metal: 0.3 });
  const rod = mat('#2a2c2d', { rough: 0.5, metal: 0.6 });
  for (const h of ctx.hulls) {
    if (h.h > 26 || h.type === 'tower' || !r.chance(0.75)) continue;
    const { minX, maxX, minZ, maxZ } = h.rect;
    const alongX = h.side === 'N' || h.side === 'S';
    const len = alongX ? maxX - minX : maxZ - minZ;
    if (len < 6) continue;
    const out = h.side === 'S' || h.side === 'E' ? 1 : -1;
    const line = h.side === 'S' ? maxZ : h.side === 'N' ? minZ : h.side === 'E' ? maxX : minX;
    const D = 2.3, y = 3.3, a = alongX ? (minX + maxX) / 2 : (minZ + maxZ) / 2;
    const place = (o: THREE.Object3D, along: number, across: number, yy: number) => {
      if (alongX) o.position.set(along, yy, line + out * across);
      else o.position.set(line + out * across, yy, along);
      ctx.stat.add(o);
      return o;
    };
    const plate = new THREE.Mesh(alongX ? new THREE.BoxGeometry(len - 0.3, 0.12, D) : new THREE.BoxGeometry(D, 0.12, len - 0.3), steel);
    plate.castShadow = true;
    place(plate, a, D / 2, y);
    place(new THREE.Mesh(alongX ? new THREE.BoxGeometry(len - 0.3, 0.32, 0.08) : new THREE.BoxGeometry(0.08, 0.32, len - 0.3), fascia), a, D, y - 0.06);
    // tie rods from the outer edge up to the facade
    const n = Math.max(2, Math.round(len / 4));
    for (let i = 0; i <= n; i++) {
      const t = a - (len - 0.6) / 2 + ((len - 0.6) * i) / n;
      const g = new THREE.CylinderGeometry(0.025, 0.025, Math.hypot(D, 2.2), 5);
      const m = new THREE.Mesh(g, rod);
      const ang = Math.atan2(D, 2.2);
      if (alongX) m.rotation.x = -out * ang;
      else m.rotation.z = out * ang;
      place(m, t, D / 2, y + 1.15);
    }
  }
}

/** Garment District: rolling garment racks with hanging coats and dresses parked along the building fronts */
export function garmentRacks(ctx: BCtx) {
  const r = new Rng(hashN(ctx.seed, 4444));
  const chrome = mat('#b8bcc0', { rough: 0.3, metal: 0.85 });
  const cloth = ['#1f2a44', '#7a1f2a', '#2a2a2a', '#c8b89a', '#3f5a3a', '#d8d4cc', '#5a3a5a', '#a87a3a'].map((c) => mat(c, { rough: 0.95 }));
  const fronts = ctx.hulls.filter((h) => h.type !== 'tower');
  let placed = 0;
  for (const h of fronts) {
    if (!r.chance(0.5) || placed > 12) continue;
    const alongX = h.side === 'N' || h.side === 'S';
    const out = h.side === 'S' || h.side === 'E' ? 1 : -1;
    const line = h.side === 'S' ? h.rect.maxZ : h.side === 'N' ? h.rect.minZ : h.side === 'E' ? h.rect.maxX : h.rect.minX;
    const a0 = alongX ? h.rect.minX : h.rect.minZ, a1 = alongX ? h.rect.maxX : h.rect.maxZ;
    const n = r.int(1, 3);
    let x = r.range(a0 + 1.5, Math.max(a0 + 1.6, a1 - 1.5 - n * 1.7));
    for (let k = 0; k < n; k++, x += 1.7) {
      const off = line + out * r.range(2.45, 2.7);
      const [px, pz] = alongX ? [x, off] : [off, x];
      if (ctx.doors.some((d) => Math.hypot(d.x - px, d.z - pz) < 2.2) || ctx.portals.some((p) => p.box.distanceToPoint(new THREE.Vector3(px, 1, pz)) < 0.2)) continue; // keep doorways clear
      const g = new THREE.Group();
      // Z-rack: base with casters, two uprights, the hanging bar
      for (const s of [-1, 1]) {
        box(g, chrome, 0.04, 1.65, 0.04, s * 0.72, 0.12, 0);
        box(g, chrome, 0.05, 0.04, 0.55, s * 0.72, 0.1, 0);
      }
      box(g, chrome, 1.5, 0.035, 0.035, 0, 1.75, 0);
      box(g, chrome, 1.4, 0.035, 0.035, 0, 0.1, 0.22);
      // garments: coats and dresses in a run of colours, slightly staggered
      const c0 = r.int(0, cloth.length - 1);
      for (let u = -0.62; u <= 0.62; u += 0.11) {
        const len = r.range(0.85, 1.25);
        const gm = box(g, cloth[(c0 + (r.chance(0.7) ? 0 : r.int(1, 3))) % cloth.length], 0.06, len, 0.48, u, 1.72 - len, 0);
        gm.rotation.y = r.range(-0.15, 0.15);
      }
      g.position.set(px, CURB, pz);
      g.rotation.y = (alongX ? 0 : Math.PI / 2) + r.range(-0.12, 0.12);
      ctx.stat.add(g);
      ctx.colliders.push(alongX ? rect(px, pz, 1.6, 0.7) : rect(px, pz, 0.7, 1.6));
      placed++;
    }
  }
}

/**
 * Music Row (W 48 St): vertical blade signs of the instrument shops hung off the facades near the avenue
 * corners, readable down the street and from the avenue (GUITARS, DRUMS, PIANOS, AMPS…), letters lit at dusk.
 */
export function musicBlades(ctx: BCtx) {
  const r = new Rng(hashN(ctx.seed, 4545));
  const words = ['GUITARS', 'DRUMS', 'PIANOS', 'AMPS', 'MUSIC', 'BASS', 'VIOLINS', 'SAX', 'REPAIRS'];
  const panelM = [mat('#1b1d22', { rough: 0.5, metal: 0.3 }), mat('#7a1418', { rough: 0.5 }), mat('#14304f', { rough: 0.5 })];
  for (const h of ctx.hulls) {
    if ((h.side !== 'N' && h.side !== 'S') || !r.chance(0.55)) continue;
    const out = h.side === 'S' ? 1 : -1, line = h.side === 'S' ? h.rect.maxZ : h.rect.minZ;
    const word = r.pick(words), H = Math.max(2.4, word.length * 0.5 + 0.4), y0 = 4.6;
    const x = r.chance(0.5) ? h.rect.minX + 0.6 : h.rect.maxX - 0.6, z = line + out * 0.75;
    box(ctx.stat, r.pick(panelM), 0.12, H, 1.0, x, y0, z);
    // brackets to the wall
    for (const yy of [y0 + 0.2, y0 + H - 0.3]) box(ctx.stat, mat('#2a2a2a', { metal: 0.6, rough: 0.5 }), 0.05, 0.05, 0.3, x, yy, line + out * 0.15);
    // the letters, one under another, on both faces
    for (const s of [-1, 1]) {
      const m = new THREE.Matrix4().compose(new THREE.Vector3(x + s * 0.065, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), s * Math.PI / 2), new THREE.Vector3(1, 1, 1));
      const col = r.pick(['#ffd34a', '#ff5a3c', '#7fe0ff', '#ffffff']);
      [...word].forEach((ch, i) => ctx.text.add(m, ch, 0, y0 + H - 0.55 - i * 0.5, 0, 0.42, 0.8, col, 1, 'neon'));
    }
  }
}


// ---------------------------------------------------------------- sidewalk furniture (Midtown, Times Square)

/** is a block-local rect free of colliders (street furniture, doors, buildings)? */
function freeAt(ctx: BCtx, x: number, z: number, w: number, d: number, pad = 0.25) {
  const r = rect(x, z, w, d);
  // doors and their portals only matter near the building line (more than 1.5 m in from the kerb)
  const front = Math.abs(x) < BX - 1.6 && Math.abs(z) < BZ - 1.6;
  if (front && ctx.doors.some((p) => Math.abs(p.x - x) < w / 2 + 1.2 && Math.abs(p.z - z) < d / 2 + 1.2)) return false;
  if (front && ctx.portals.some((p) => p.box.distanceToPoint(new THREE.Vector3(x, 1, z)) < Math.max(w, d) / 2 + 0.2)) return false;
  return !ctx.colliders.some((c) => overlaps(c, r, pad));
}

/** a granite planter box with clipped shrubs and seasonal flowers (Fifth Avenue BID) */
function planter(ctx: BCtx, x: number, z: number, alongX: boolean, r: Rng) {
  const L = 1.8, W = 0.75;
  const [w, d] = alongX ? [L, W] : [W, L];
  box(ctx.stat, mat('#8e8b84', { rough: 0.85 }), w, 0.55, d, x, CURB, z);
  box(ctx.stat, mat('#b1aea6', { rough: 0.8 }), w + 0.08, 0.06, d + 0.08, x, CURB + 0.55, z);
  box(ctx.stat, mat('#3b2d22', { rough: 1 }), w - 0.12, 0.05, d - 0.12, x, CURB + 0.57, z);
  const leaf = [mat('#3f6a2c', { rough: 0.9 }), mat('#4f7a34', { rough: 0.9 })];
  const flower = mat(r.pick(['#c4304a', '#e8d24a', '#d86aa0', '#f2f0ea', '#7a4ab0']), { rough: 0.9 });
  for (let k = -1; k <= 1; k++) {
    const o = new THREE.Mesh(new THREE.IcosahedronGeometry(0.32, 0), k ? r.pick(leaf) : flower);
    o.scale.set(1, 0.8, 1);
    o.position.set(x + (alongX ? k * 0.55 : 0), CURB + 0.82, z + (alongX ? 0 : k * 0.55));
    o.castShadow = true;
    ctx.stat.add(o);
  }
  ctx.colliders.push(rect(x, z, w, d));
}

/** a row of inverted-U bike staples */
function bikeRacks(ctx: BCtx, x: number, z: number, alongX: boolean, n: number) {
  const steel = mat('#4a4f52', { rough: 0.5, metal: 0.6 });
  for (let i = 0; i < n; i++) {
    const t = (i - (n - 1) / 2) * 0.9;
    const [px, pz] = alongX ? [x + t, z] : [x, z + t];
    // staples stand across the sidewalk
    for (const s of [-1, 1]) box(ctx.stat, steel, 0.05, 0.85, 0.05, px + (alongX ? 0 : s * 0.3), CURB, pz + (alongX ? s * 0.3 : 0));
    box(ctx.stat, steel, alongX ? 0.05 : 0.65, 0.05, alongX ? 0.65 : 0.05, px, CURB + 0.85, pz);
  }
  ctx.colliders.push(alongX ? rect(x, z, n * 0.9, 0.8) : rect(x, z, 0.8, n * 0.9));
}

let plateTex: THREE.Texture | null = null;
/** a sidewalk vault: diamond-plate steel doors or a grid of glass prisms, flush with the pavement */
function vault(ctx: BCtx, x: number, z: number, alongX: boolean, r: Rng) {
  plateTex ??= canvasTex(64, 64, (g) => {
    g.fillStyle = '#5c5f61';
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = 'rgba(200,200,200,0.35)';
    for (let y = 0; y < 64; y += 8) for (let xx = (y / 8) % 2 ? 4 : 0; xx < 64; xx += 8) g.fillRect(xx + 1, y + 2, 5, 2);
  }, true);
  const w = r.range(1.2, 1.8), d = r.range(0.9, 1.3);
  const [ww, dd] = alongX ? [w, d] : [d, w];
  const m = new THREE.Mesh(new THREE.PlaneGeometry(ww, dd).rotateX(-Math.PI / 2), mat('#ffffff', { rough: 0.45, metal: 0.6, map: plateTex }));
  const uv = m.geometry.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * ww * 3, uv.getY(i) * dd * 3);
  m.position.set(x, CURB + 0.006, z);
  m.receiveShadow = true;
  ctx.stat.add(m);
  // the hinge seam and a frame
  box(ctx.stat, mat('#3a3c3d', { rough: 0.5, metal: 0.6 }), alongX ? ww : 0.04, 0.008, alongX ? 0.04 : dd, x, CURB, z);
}

/**
 * Midtown / Times Square sidewalks: the Fifth Avenue streetscape between the kerb furniture streetExtras()
 * already places — planters and litter baskets at the kerb, bike staples, the odd newsstand or Citi Bike dock,
 * vault doors along the building line. Every piece checks the colliders (lamps, signals, hydrants, doors).
 */
export function midtownSidewalks(ctx: BCtx) {
  const r = new Rng(hashN(ctx.seed, 4646));
  for (const sx of [-1, 1]) {
    // the avenue sides: kerb zone x = ±(BX - 0.9), building zone x = ±(LX + 0.9)
    const kx = sx * (BX - 0.95), bx = sx * (LX + 0.9);
    for (let z = -BZ + 6; z < BZ - 6; z += r.range(3.5, 5.5)) {
      const roll = r.next();
      if (roll < 0.35 && freeAt(ctx, kx, z, 0.8, 1.9)) planter(ctx, kx, z, false, r);
      else if (roll < 0.5 && freeAt(ctx, kx, z, 0.6, 0.6)) { litterBasket(ctx.stat, kx, z, r.range(0, 6)); ctx.colliders.push(rect(kx, z, 0.6, 0.6)); }
      else if (roll < 0.62 && freeAt(ctx, kx, z, 0.8, 3)) bikeRacks(ctx, kx, z, false, 3);
      if (r.chance(0.3) && freeAt(ctx, bx, z + 2, 1.4, 1.8, 0.05)) vault(ctx, bx, z + 2, false, r);
    }
    if (r.chance(0.5)) {
      const z = r.range(-BZ + 9, BZ - 9), x = sx * (BX - 1.5);
      if (freeAt(ctx, x, z, 1.8, 3.2)) { newsstand(ctx.stat, x, z, sx > 0 ? -Math.PI / 2 : Math.PI / 2); ctx.colliders.push(rect(x, z, 1.7, 3.1)); }
    }
  }
  for (const sz of [-1, 1]) {
    // the street sides
    const kz = sz * (BZ - 0.95), bz = sz * (LZ + 0.9);
    for (let x = -LX + 6; x < LX - 6; x += r.range(4, 7)) {
      const roll = r.next();
      if (roll < 0.25 && freeAt(ctx, x, kz, 1.9, 0.8)) planter(ctx, x, kz, true, r);
      else if (roll < 0.4 && freeAt(ctx, x, kz, 2.8, 0.8)) bikeRacks(ctx, x, kz, true, 3);
      if (r.chance(0.25) && freeAt(ctx, x + 2, bz, 1.8, 1.4, 0.05)) vault(ctx, x + 2, bz, true, r);
    }
    if (r.chance(0.35)) {
      const n = r.int(6, 10), len = n * 0.85 + 0.5, x0 = r.range(-LX + 10, LX - 10 - len), z = sz * (BZ - 0.75);
      if (freeAt(ctx, x0 + len / 2, z, len, 0.9)) { bikeDock(ctx.stat, x0, z, sz > 0 ? Math.PI : 0, n, r); ctx.colliders.push(rect(x0 + len / 2, z, len, 0.85)); }
    }
  }
}

// ---------------------------------------------------------------- avenue-end landmarks

/** Duffy Square: the TKTS red steps on the Times Square avenue end of (2,-3) */
export function tktsAt(cx: number, cz: number, end: number) {
  return cx === 2 && cz === -3 && end > 0;
}
/** Hudson Yards supertalls on the construction blocks' built avenue end */
const SUPERTALL: Record<string, { floors: number; edge: boolean }> = { '4,-2': { floors: 82, edge: true }, '4,0': { floors: 66, edge: false } };

/**
 * An avenue frontage built by this module instead of nyc.ts's default buildings; true when handled.
 * x0..x1: the frontage rect along x (block-local), the whole block depth along z.
 */
export function landmarkFrontage(ctx: BCtx, end: number, x0: number, x1: number) {
  if (tktsAt(ctx.cx, ctx.cz, end)) {
    duffySquare(ctx, x0, x1);
    return true;
  }
  const st = SUPERTALL[`${ctx.cx},${ctx.cz}`];
  if (st && !ctx.hulls.some((h) => h.h > 150)) {
    supertall(ctx, x0, x1, end > 0 ? 'E' : 'W', st.floors, st.edge);
    return true;
  }
  return false;
}

let redGlass: THREE.MeshStandardMaterial | null = null;
const group = (ctx: BCtx) => ctx.group;
/** the TKTS stairs: 27 red glass risers rising to ~5 m over the booth, a plaza of pavers, planters, red tables */
function duffySquare(ctx: BCtx, x0: number, x1: number) {
  const r = new Rng(hashN(ctx.seed, 4747));
  const { stat, colliders } = ctx;
  const xc = (x0 + x1) / 2;
  // the plaza: grey-and-charcoal pavers (the Times Square reconstruction)
  const pav = canvasTex(128, 128, (g) => {
    g.fillStyle = '#7d7b77';
    g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 160; i++) {
      g.fillStyle = r.chance(0.5) ? '#6f6d69' : '#8b8882';
      g.fillRect(r.int(0, 15) * 8, r.int(0, 15) * 8, 8, 8);
    }
  }, true);
  const plaza = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, LZ * 2).rotateX(-Math.PI / 2), mat('#ffffff', { rough: 0.85, map: pav }));
  const uv = plaza.geometry.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (x1 - x0) / 2, uv.getY(i) * LZ);
  plaza.position.set(xc, CURB + 0.004, 0);
  plaza.receiveShadow = true;
  stat.add(plaza);
  // the steps: 9 m wide (along the avenue), rising towards the north (-z) over 14 m
  redGlass ??= new THREE.MeshStandardMaterial({ color: '#c8102e', emissive: new THREE.Color('#ff2040'), emissiveIntensity: 0.55, roughness: 0.15, metalness: 0.1 });
  const W = 9, N = 27, rise = 0.18, tread = 0.5, z0 = 7;
  for (let k = 0; k < N; k++) {
    const st = new THREE.Mesh(new THREE.BoxGeometry(W, rise, tread + 0.02), redGlass);
    st.position.set(xc, CURB + rise * (k + 0.5), z0 - k * tread);
    st.castShadow = true;
    stat.add(st);
  }
  // the structure under the steps: the TKTS booth (glass box with a red sign band) and a dark steel back
  const top = CURB + N * rise, zb = z0 - N * tread;
  box(stat, mat('#202326', { rough: 0.5, metal: 0.5 }), W, top - CURB, 0.2, xc, CURB, zb - 0.1);
  // glass cheek walls following the slope of the steps
  const cheek = new THREE.Shape();
  cheek.moveTo(0, 0);
  cheek.lineTo(z0 - zb, 0);
  cheek.lineTo(z0 - zb, top - CURB + 0.9);
  cheek.lineTo(0, rise + 0.9);
  cheek.closePath();
  const cg = new THREE.ExtrudeGeometry(cheek, { depth: 0.06, bevelEnabled: false });
  cg.rotateY(Math.PI / 2);
  const glassM = new THREE.MeshStandardMaterial({ color: '#c9d6dc', roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.35, depthWrite: false });
  for (const s of [-1, 1]) {
    const m = new THREE.Mesh(cg, glassM);
    m.position.set(xc + s * (W / 2 + 0.05), CURB, z0);
    group(ctx).add(m);
  }
  box(stat, mat('#1e2a33', { rough: 0.1, metal: 0.4 }), W - 1, 2.6, 0.1, xc, CURB, zb - 0.25);
  box(stat, redGlass, W - 1, 0.6, 0.12, xc, CURB + 2.7, zb - 0.27);
  ctx.text.add(new THREE.Matrix4().makeRotationY(Math.PI).setPosition(xc, 0, zb - 0.34), 'tkts', 0, CURB + 2.78, 0, 0.42, 3, '#ffffff', 1, 'neon');
  colliders.push(rect(xc, (z0 + zb) / 2 - 0.2, W + 0.3, z0 - zb + 0.4));
  // planters, red café tables and chairs on the plaza
  for (const z of [-LZ + 3, LZ - 3]) for (const dx of [-6, 6]) planter(ctx, xc + dx, z, true, r);
  const red = mat('#b3122a', { rough: 0.5, metal: 0.3 });
  for (let i = 0; i < 6; i++) {
    const x = xc + r.range(-7, 7), z = r.range(9, LZ - 5);
    if (!freeAt(ctx, x, z, 1.6, 1.6)) continue;
    box(stat, red, 0.06, 0.72, 0.06, x, CURB, z);
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.03, 16), red);
    t.position.set(x, CURB + 0.73, z);
    stat.add(t);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + r.range(0, 1);
      box(stat, red, 0.42, 0.45, 0.42, x + Math.cos(a) * 0.65, CURB, z + Math.sin(a) * 0.65);
    }
    colliders.push(rect(x, z, 1.4, 1.4));
  }
  ctx.hulls.push({ rect: { minX: x0, maxX: x1, minZ: -LZ, maxZ: LZ }, h: top, top: 0.5, side: 'E', type: 'midrise' });
}

/** 30 / 10 Hudson Yards: a glass supertall with a sloped crown and (on the taller) the Edge's cantilevered deck */
function supertall(ctx: BCtx, x0: number, x1: number, side: Side, floors: number, edge: boolean) {
  const r: Rect = { minX: x0, maxX: x1, minZ: -LZ, maxZ: LZ };
  building(ctx, r, side, 'tower', floors, true, [true, true], { material: 'glass' });
  const h = ctx.hulls[ctx.hulls.length - 1]?.h ?? 7.2 + floors * 3.6;
  const glass = mat('#6f8597', { rough: 0.08, metal: 0.85 });
  const xc = (x0 + x1) / 2, W = x1 - x0, D = LZ * 2;
  // the crown: a slanted glass wedge rising 36 m to a point over the north face
  const sh = new THREE.Shape();
  sh.moveTo(-D / 2, 0);
  sh.lineTo(D / 2, 0);
  sh.lineTo(-D / 2 + 2, 36);
  sh.closePath();
  const g = new THREE.ExtrudeGeometry(sh, { depth: W - 1, bevelEnabled: false });
  g.rotateY(Math.PI / 2);
  g.translate(xc - (W - 1) / 2, h, 0);
  const crown = new THREE.Mesh(g, glass);
  crown.castShadow = true;
  ctx.stat.add(crown);
  if (edge) {
    // the Edge: a triangular deck cantilevered 20 m out of the south-west corner, ~0.9 h up, glass walls
    const t = new THREE.Shape();
    t.moveTo(0, 0);
    t.lineTo(W * 0.9, 0);
    t.lineTo(W * 0.2, -22);
    t.closePath();
    const dg = new THREE.ExtrudeGeometry(t, { depth: 1.2, bevelEnabled: false });
    dg.rotateX(Math.PI / 2);
    const deck = new THREE.Mesh(dg, mat('#d8dcdf', { rough: 0.4, metal: 0.6 }));
    deck.position.set(x0 + 0.5, h * 0.9, LZ);
    deck.castShadow = true;
    ctx.stat.add(deck);
  }
  // occlusion / HLOD: the crown on top of the tower's hull
  const hull = ctx.hulls[ctx.hulls.length - 1];
  if (hull) hull.h = h + 30;
}

/** Greenmarket: white market tents with produce crates on the avenue sidewalks */
export function marketStalls(ctx: BCtx) {
  const r = new Rng(hashN(ctx.seed, 4848));
  const crateM = [mat('#9a7a52', { rough: 0.9 })];
  const fruit = ['#c4302a', '#e89a2a', '#6f9a34', '#e8d24a', '#7a3a6a', '#3f6a2c'].map((c) => mat(c, { rough: 0.8 }));
  for (const sx of [-1, 1]) {
    const x = sx * (BX - 1.55);
    for (let z = -BZ + 8; z < BZ - 8; z += r.range(5, 7)) {
      if (!freeAt(ctx, x, z, 2.2, 3.2)) continue;
      stall(ctx.stat, x, CURB, z, sx > 0 ? Math.PI / 2 : -Math.PI / 2, r.pick(['#f2f0ea', '#f2f0ea', '#e8e2d2', '#2f5a3a']), 3, 2);
      // crates of produce on the table and stacked in front
      for (let k = -1; k <= 1; k++) {
        const cz = z + k * 0.9, cx = x - sx * 0.55;
        box(ctx.stat, crateM[0], 0.5, 0.22, 0.75, cx, CURB + 0.8, cz);
        box(ctx.stat, r.pick(fruit), 0.44, 0.08, 0.68, cx, CURB + 1.0, cz);
        if (r.chance(0.5)) { box(ctx.stat, crateM[0], 0.5, 0.3, 0.6, cx - sx * 0.6, CURB, cz); box(ctx.stat, r.pick(fruit), 0.44, 0.06, 0.54, cx - sx * 0.6, CURB + 0.3, cz); }
      }
      ctx.colliders.push(rect(x, z, 2.2, 3.1));
    }
  }
}

/** the extras for one built block */
export function neighbourhoodExtras(ctx: BCtx, d: District) {
  if (d.kind === 'industrial') {
    buildHighLine(ctx);
    if (ctx.cz >= 0) meatCanopies(ctx);
  }
  if (d.kind === 'garment') garmentRacks(ctx);
  if (d.kind === 'music') musicBlades(ctx);
  if (d.kind === 'midtown' || d.kind === 'timesq') midtownSidewalks(ctx);
  if (d.kind === 'market') marketStalls(ctx);
}
void LX; void LZ; void SW;
export type { Rect };
