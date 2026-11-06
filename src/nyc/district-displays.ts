import * as THREE from 'three';
import { rect } from '../level';
import { Rng, hashN } from '../rng';
import { BZ, SW, CURB } from './common';
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

export function sidewalkDisplays(ctx: BCtx, d: District) {
  if (!d.displays.length || !ctx.doors.length) return;
  const r = new Rng(hashN(ctx.seed, 808));
  const slot = slotter(ctx);
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
