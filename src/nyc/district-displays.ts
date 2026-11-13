import { tktsAt } from './nbhd'; // [nbhd]
import { ScreenBatch } from './billboards'; // [nbhd]
import * as THREE from 'three';
import { rect } from '../level';
import { Rng, hashN } from '../rng';
import { BZ, SW, CURB, LX, LZ } from './common';
import { kit, place, PM } from './streetprops';
import { mat } from '../build';
import type { BCtx } from './buildings';
import type { District } from './districts';
import { slotter } from './district-custom';

/**
 * Sidewalk displays outside the shops, as on the Bowery (stacked stock pots, lamps hung out front),
 * Canal Street (tables of electronics, tools and toys), the greenmarket streets (fruit crates) and
 * brownstone stoop sales (a chair, an old lamp, a box of books): a folding table or the bare
 * pavement beside the door, stocked from the district's showcase pools at real size.
 */

const BIG = new Set(['furniture', 'appliance', 'bath', 'machine', 'freight', 'lighting', 'music']);

function table(parent: THREE.Object3D, x: number, z: number, ry: number) {
  const parts = kit('display-table', (k) => {
    k.add(new THREE.BoxGeometry(1.5, 0.04, 0.7), mat('#d8d2c2', { rough: 0.8 }), 0, 0.76, 0);
    for (const sx of [-1, 1]) {
      const leg = new THREE.BoxGeometry(0.03, 0.78, 0.6);
      k.add(leg, PM.galv(), sx * 0.65, 0.38, 0);
    }
    k.add(new THREE.BoxGeometry(1.5, 0.5, 0.02), mat('#3a5f8a', { rough: 0.9 }), 0, 0.5, 0.34); // skirt
  });
  place(parent, parts, x, CURB, z, ry);
}

// ---------------------------------------------------------------- Times Square billboards

// [nbhd] the ad atlas, LED material and screen batch live in nyc/billboards.ts

/**
 * Giant lit billboards stacked on the avenue facades, the signature of Times Square: each a
 * plane with one cell of the ad atlas, self-lit (emissive) so they glow at dusk.
 */
function billboards(ctx: BCtx, r: Rng) {
  const screens = new ScreenBatch(r); // [nbhd] procedural LED ad atlas, tickers, crossfades (nyc/billboards.ts)
  const frame = flatFrame();
  const quad = (cx: number, cy: number, cz: number, w: number, h: number, ry: number, cell: number | 'ticker') => {
    screens.add(cx, cy, cz, w, h, ry, cell === 'ticker' ? 'ticker' : 'ad');
    // a dark steel frame behind it
    const f = new THREE.Mesh(new THREE.BoxGeometry(w + 0.4, h + 0.4, 0.3), frame);
    f.position.set(cx - Math.sin(ry) * 0.2, cy, cz - Math.cos(ry) * 0.2);
    f.rotation.y = ry;
    f.userData.owned = true;
    ctx.stat.add(f);
  };
  for (const s of [-1, 1]) {
    // [nbhd] Duffy Square: the screens hang on the walls behind the plaza (20 m in), up to those walls' tops
    const plaza = tktsAt(ctx.cx, ctx.cz, s);
    const wallTop = plaza ? Math.max(18, ...ctx.hulls.filter((h) => Math.abs((s > 0 ? h.rect.maxX : h.rect.minX) - s * (LX - 20)) < 0.6).map((h) => h.top)) - 1 : 52;
    // facing the avenue: the facade at x = s * LX, normal +s x
    const ry = s > 0 ? Math.PI / 2 : -Math.PI / 2;
    const x = s * (plaza ? LX - 20 + 0.45 : LX + 0.45);
    // two columns of stacked screens, nearly wall to wall
    // [nbhd] a news / stock ticker wrapping the facade just over the storefronts
    quad(x, 5.4, 0, 2 * LZ - 2, 1.4, ry, 'ticker');
    for (const col of [-1, 1]) {
      let y = r.range(6.6, 7.2); // [nbhd] screens start right over the ticker and run higher (street-level audit)
      for (let k = 0; k < 7 && y < wallTop - 5; k++) {
        const h = Math.min(r.range(5, 10), wallTop - y), w = r.range(14, LZ - 2);
        const z = col * (w / 2 + 0.6);
        quad(x, y + h / 2, z, w, h, ry, r.int(0, 9));
        y += h + r.range(0.8, 2.5);
      }
    }
    // a wraparound band on each corner building, facing the cross streets
    for (const sz of plaza ? [] : [-1, 1]) {
      const zf = sz * (LZ + 0.45);
      const w = r.range(10, 16);
      quad(s * (LX - w / 2 - 1), r.range(8, 14), zf, w, r.range(3.5, 6), sz > 0 ? 0 : Math.PI, r.int(0, 9));
    }
  }
  ctx.group.add(screens.mesh());
}
let frameM: THREE.MeshStandardMaterial | null = null;
function flatFrame() {
  return (frameM ??= new THREE.MeshStandardMaterial({ color: '#202224', roughness: 0.6, metalness: 0.5 }));
}

/**
 * The Bowery's appliance and restaurant-supply row: ranges, fridges, mixers, washers and ice
 * machines lined up on the sidewalk against the shopfronts of one side street, clear of the doors.
 */
function applianceRow(ctx: BCtx, r: Rng) {
  const slot = slotter(ctx);
  const sz = r.chance(0.5) ? 1 : -1;
  const z = sz * (LZ + 0.75);
  for (let x = -18; x <= 18; x += 1.35) {
    if (ctx.doors.some((p) => Math.abs(p.x - x) < 1.6 && Math.sign(p.z) === sz)) continue;
    slot({ kind: ['applianceRow', 'appliance'], x, y: CURB, z, rot: 0, w: 1.2, d: 0.95, h: 2.1, min: 0.45, radius: 50, maxTris: 80_000 });
  }
}

export function sidewalkDisplays(ctx: BCtx, d: District) {
  if (d.kind === 'timesq') billboards(ctx, new Rng(hashN(ctx.seed, 77)));
  if (d.kind === 'bowery') applianceRow(ctx, new Rng(hashN(ctx.seed, 78)));
  if (!d.displays.length || !ctx.doors.length) return;
  const r = new Rng(hashN(ctx.seed, 808));
  const slot = slotter(ctx);
  const placed: [number, number][] = [];
  let n = 0;
  for (const door of ctx.doors) {
    if (n >= 7 || !r.chance(0.55)) continue;
    // which way the shop faces: streets along x (|z| near the kerb), avenues along z
    const street = Math.abs(Math.abs(door.z) - BZ) < 1.5;
    const nx = street ? 0 : Math.sign(door.x), nz = street ? Math.sign(door.z) : 0;
    const fx = door.x - nx * SW, fz = door.z - nz * SW; // the facade at the door
    const side = r.chance(0.5) ? 1 : -1;
    const tx = street ? fx + side * 1.9 : fx + nx * 1.0, tz = street ? fz + nz * 1.0 : fz + side * 1.9;
    const ry = street ? (nz > 0 ? 0 : Math.PI) : nx > 0 ? Math.PI / 2 : -Math.PI / 2;
    const kind = r.pick(d.displays);
    // two doors close together (a shop beside a building door) would stack their displays: one each
    if (placed.some(([px, pz]) => Math.hypot(px - tx, pz - tz) < 2.2)) continue;
    placed.push([tx, tz]);
    if (BIG.has(kind)) {
      slot({ kind, x: tx, y: CURB, z: tz, rot: ry + Math.PI / 2, w: 1.6, d: 1.0, h: 2.2, min: 0.3, radius: 55, maxTris: 100_000 });
    } else {
      table(ctx.stat, tx, tz, ry);
      ctx.colliders.push(street ? rect(tx, tz, 1.5, 0.7) : rect(tx, tz, 0.7, 1.5));
      for (const u of [-0.42, 0.42]) {
        const ox = street ? u : 0, oz = street ? 0 : u;
        slot({ kind, x: tx + ox, y: CURB + 0.78, z: tz + oz, rot: ry + r.range(-0.5, 0.5), w: 0.7, d: 0.6, h: 0.7, min: 0.05, radius: 40, maxTris: 40_000 }, false);
      }
    }
    n++;
  }
}
