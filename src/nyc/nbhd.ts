import * as THREE from 'three';
import { SZ, LX, LZ, BZ, CURB, SW, canvasTex } from './common';
import { rect, type Rect } from '../level';
import { Rng, hashN } from '../rng';
import { mat } from '../build';
import type { BCtx } from './buildings';
import type { District } from './districts';
import { WaterKit } from './waterfront';
import { addTree } from './streettrees';
import { parkBench } from './district-props';

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
      const off = line + out * r.range(1.1, 1.6);
      const [px, pz] = alongX ? [x, off] : [off, x];
      if (ctx.doors.some((d) => Math.hypot(d.x - px, d.z - pz) < 2.2) || ctx.portals.some((p) => p.box.distanceToPoint(new THREE.Vector3(px, 1, pz)) < 1.2)) continue; // keep doorways clear
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

/** the extras for one built block */
export function neighbourhoodExtras(ctx: BCtx, d: District) {
  if (d.kind === 'industrial') {
    buildHighLine(ctx);
    if (ctx.cz >= 0) meatCanopies(ctx);
  }
  if (d.kind === 'garment') garmentRacks(ctx);
}
void LX; void LZ; void SW;
export type { Rect };
