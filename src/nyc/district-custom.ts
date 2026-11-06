import * as THREE from 'three';
import { rect } from '../level';
import { Rng, hashN } from '../rng';
import { LX, LZ, CURB } from './common';
import { carMesh } from './vehicles';
import type { BCtx } from './buildings';
import type { District } from './districts';
import type { Plan } from './district-build';
import { addSlot, type SlotSpec } from './district-showcase';
import { flat, slab, apronMat } from './district-tex';
import { chainFence, jersey } from './district-props';
import { buildYard, buildConstruction, buildPlaza, buildMuseum } from './district-yards';

/**
 * Blocks with something other than buildings on part of them: auto row showrooms and lots,
 * construction sites, the greenmarket plaza, rail and container yards, the museum steps.
 * Returns which default frontages nyc.ts should still build.
 */
export function customBlock(ctx: BCtx, d: District): Plan {
  const all: Plan = { ave: [true, true], rows: [true, true] };
  const r = new Rng(hashN(ctx.seed, 404));
  switch (d.kind) {
    case 'autorow':
      return autoRow(ctx, r);
    case 'construction':
      return buildConstruction(ctx, r);
    case 'industrial':
      return buildYard(ctx, r);
    case 'market':
      return buildPlaza(ctx, r);
    case 'museum':
      return buildMuseum(ctx, r);
  }
  return all;
}

export type CSlot = (s: Omit<SlotSpec, 'seed'>, col?: boolean) => void;
export function slotter(ctx: BCtx): CSlot {
  return (s, col = true) => {
    addSlot(ctx.group, ctx.portals, { ...s, seed: hashN(ctx.seed, Math.round(s.x * 10), Math.round(s.z * 10)) });
    if (col) {
      const turn = Math.abs(Math.sin(s.rot ?? 0)) > 0.7;
      ctx.colliders.push(rect(s.x, s.z, (turn ? s.d : s.w) * 0.85, (turn ? s.w : s.d) * 0.85));
    }
  };
}

/** a sign of lit letters on a frame at (x,y,z) facing yaw `ry` */
export function sign(ctx: BCtx, text: string, x: number, y: number, z: number, ry: number, h: number, maxW: number, color = '#ffffff', kind: 'sign' | 'neon' | 'paint' = 'sign') {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry), new THREE.Vector3(1, 1, 1));
  ctx.text.add(m, text, 0, 0, 0, h, maxW, color, 0, kind);
}

const BRANDS = ['HUDSON MOTORS', 'WEST SIDE AUTO', 'ELEVENTH AVE IMPORTS', 'MANHATTAN MOTOR CARS', 'PIER 76 AUTO', 'EMPIRE CAR CO', 'RIVERSIDE CHEVROLET', 'MIDTOWN MOTORS'];

// ---------------------------------------------------------------- auto row

/**
 * Eleventh Avenue's auto row: a two-storey glass showroom on one avenue end (cars on a polished
 * floor, walk-in through the glass doors), a dealer lot of real-scale cars on the other end with
 * pennant strings, and a used-car lot behind a chain-link fence on one side street.
 */
function autoRow(ctx: BCtx, r: Rng): Plan {
  const slot = slotter(ctx);
  const west = r.chance(0.5); // showroom on the -x end
  const s = west ? -1 : 1;
  const brand = r.pick(BRANDS);
  // ---- showroom: x from s*LX to s*(LX-22), the whole block depth
  {
    const x0 = Math.min(s * LX, s * (LX - 20)), x1 = Math.max(s * LX, s * (LX - 20));
    const z0 = -LZ, z1 = LZ, H = 8.5;
    const xc = (x0 + x1) / 2;
    const floor = new THREE.MeshStandardMaterial({ color: '#d9d8d3', roughness: 0.18, metalness: 0.05 });
    ctx.stat.add(slab(floor, x0, x1, z0, z1, CURB + 0.02, 2));
    // roof slab and fascia with the brand
    const roof = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0 + 0.6, 0.6, z1 - z0 + 0.6), flat('#ecebe6', 0.6));
    roof.position.set(xc, H + 0.3, 0);
    roof.castShadow = true;
    roof.userData.owned = true;
    ctx.stat.add(roof);
    const fx = s * LX + s * 0.32; // street face
    sign(ctx, brand, fx + s * 0.02, H + 0.3, 0, s > 0 ? Math.PI / 2 : -Math.PI / 2, 0.42, 30, '#1b2a44');
    // glass walls on the three outer sides, black mullions every 3 m; the back wall is solid
    const glass = new THREE.MeshPhysicalMaterial({ color: '#cfdde3', roughness: 0.05, metalness: 0, transmission: 0, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide });
    const mull = flat('#1b1d20', 0.4, 0.6);
    const pane = (ax: 'x' | 'z', c: number, a0: number, a1: number) => {
      const len = a1 - a0;
      const g = new THREE.Mesh(new THREE.PlaneGeometry(len, H), glass);
      g.position.set(ax === 'z' ? c : (a0 + a1) / 2, CURB + H / 2, ax === 'z' ? (a0 + a1) / 2 : c);
      g.rotation.y = ax === 'z' ? Math.PI / 2 : 0;
      g.userData.owned = true;
      ctx.group.add(g);
      for (let u = a0; u <= a1 + 0.01; u += len / Math.max(1, Math.round(len / 3))) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(0.12, H, 0.12), mull);
        m.position.set(ax === 'z' ? c : u, CURB + H / 2, ax === 'z' ? u : c);
        m.userData.owned = true;
        ctx.stat.add(m);
      }
      const t = new THREE.Mesh(new THREE.BoxGeometry(ax === 'z' ? 0.14 : len, 0.14, ax === 'z' ? len : 0.14), mull);
      t.position.set(ax === 'z' ? c : (a0 + a1) / 2, CURB + 4.4, ax === 'z' ? (a0 + a1) / 2 : c);
      t.userData.owned = true;
      ctx.stat.add(t);
    };
    // avenue face with a 4 m entrance in the middle
    pane('z', s * LX, z0, -2);
    pane('z', s * LX, 2, z1);
    ctx.colliders.push({ minX: s * LX - 0.2, maxX: s * LX + 0.2, minZ: z0, maxZ: -2 }, { minX: s * LX - 0.2, maxX: s * LX + 0.2, minZ: 2, maxZ: z1 });
    pane('x', z0, x0, x1);
    pane('x', z1, x0, x1);
    ctx.colliders.push({ minX: x0, maxX: x1, minZ: z0 - 0.2, maxZ: z0 + 0.2 }, { minX: x0, maxX: x1, minZ: z1 - 0.2, maxZ: z1 + 0.2 });
    const backX = s * (LX - 20);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.4, H, z1 - z0), flat('#f1f0ec', 0.8));
    back.position.set(backX, CURB + H / 2, 0);
    back.userData.owned = true;
    ctx.stat.add(back);
    ctx.colliders.push({ minX: backX - 0.3, maxX: backX + 0.3, minZ: z0, maxZ: z1 });
    // sales desks along the back wall
    for (const z of [-12, 12]) {
      const desk = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.76, 2.4), flat('#2a2c30', 0.5));
      desk.position.set(backX - s * 2.5, CURB + 0.38, z);
      desk.userData.owned = true;
      ctx.stat.add(desk);
      ctx.colliders.push(rect(backX - s * 2.5, z, 1.4, 2.6));
    }
    // cars on the showroom floor, angled toward the glass
    const spots: [number, number][] = [[-15, 0.5], [-6.5, -0.4], [6.5, 0.4], [15, -0.5]];
    for (const [z, a] of spots) slot({ kind: ['carShow', 'car'], x: s * (LX - 6.5), y: CURB + 0.02, z, rot: a, w: 6.2, d: 2.6, h: 2.6, min: 3.4, radius: 120, maxTris: 300_000 });
    for (const z of [-11, 11]) slot({ kind: ['car', 'bike'], x: s * (LX - 14.5), y: CURB + 0.02, z, rot: Math.PI / 2, w: 6, d: 2.6, h: 2.6, min: 1.6, radius: 110, maxTris: 250_000 });
  }
  // ---- the dealer lot on the other avenue end
  {
    const e = -s;
    const x0 = Math.min(e * LX, e * (LX - 20)), x1 = Math.max(e * LX, e * (LX - 20));
    ctx.stat.add(slab(apronMat(), x0, x1, -LZ, LZ, CURB + 0.01, 10));
    lot(ctx, slot, x0, x1, -LZ + 1, LZ - 1, e, r);
    // pennant strings across the lot, a SALE sign on a pole
    pennants(ctx, (x0 + x1) / 2, -LZ + 1, (x0 + x1) / 2, LZ - 1, 5.2);
    pennants(ctx, x0 + 1, -LZ + 1, x1 - 1, LZ - 1, 4.8);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 7, 8), flat('#9a9ea2', 0.4, 0.8));
    pole.position.set(e * (LX - 1), CURB + 3.5, 0);
    pole.userData.owned = true;
    ctx.stat.add(pole);
    const board = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.6, 6), flat('#c21f2a', 0.5));
    board.position.set(e * (LX - 1), CURB + 6.4, 0);
    board.userData.owned = true;
    ctx.stat.add(board);
    sign(ctx, 'CERTIFIED PRE-OWNED', e * (LX - 0.82), CURB + 6.4, 0, e > 0 ? Math.PI / 2 : -Math.PI / 2, 0.55, 5.6, '#ffffff');
  }
  // ---- a used-car lot on one side street, behind a fence
  const row = r.chance(0.5) ? 1 : -1;
  {
    const z0 = row > 0 ? LZ - 17 : -LZ, z1 = row > 0 ? LZ : -LZ + 17;
    const x0 = -LX + 20, x1 = LX - 20;
    ctx.stat.add(slab(apronMat(), x0, x1, z0, z1, CURB + 0.01, 10));
    const fz = row * LZ;
    chainFence(ctx.stat, x0, fz, -3, fz, 2.2, CURB);
    chainFence(ctx.stat, 3, fz, x1, fz, 2.2, CURB);
    ctx.colliders.push({ minX: x0, maxX: -3, minZ: fz - 0.15, maxZ: fz + 0.15 }, { minX: 3, maxX: x1, minZ: fz - 0.15, maxZ: fz + 0.15 });
    // a row of cars nose to the fence, a second row of street cars behind, a sales trailer
    for (let x = x0 + 2; x < x1 - 2; x += 3.1) {
      if (Math.abs(x) < 4) continue;
      slot({ kind: ['car', 'truck'], x, y: CURB + 0.01, z: fz - row * 3.4, rot: Math.PI / 2, w: 5.6, d: 2.7, h: 3.2, min: 3.2, radius: 85, maxTris: 150_000 });
    }
    for (let x = x0 + 2.5; x < x1 - 8; x += 6.4) {
      const car = carMesh(r.chance(0.1) ? 'cab' : 'sedan', r);
      car.position.set(x, CURB, fz - row * 11);
      car.rotation.y = r.chance(0.5) ? 0 : Math.PI;
      ctx.group.add(car);
      ctx.colliders.push(rect(x, fz - row * 11, 1.9, 4.6));
    }
    const trailer = new THREE.Mesh(new THREE.BoxGeometry(7, 2.8, 2.6), flat('#e6e2d6', 0.7));
    trailer.position.set(x1 - 4.5, CURB + 1.6, fz - row * 11);
    trailer.castShadow = true;
    trailer.userData.owned = true;
    ctx.stat.add(trailer);
    ctx.colliders.push(rect(x1 - 4.5, fz - row * 11, 7, 2.6));
    sign(ctx, 'USED CARS · WE FINANCE', 0, CURB + 3.2, fz + row * 0.05, row > 0 ? 0 : Math.PI, 0.5, 9, '#ffd23f', 'paint');
    jersey(ctx.stat, -1.5, CURB, fz - row * 0.6, 0);
  }
  return { ave: west ? [false, false] : [false, false], rows: row > 0 ? [true, false] : [false, true] };
}

/** a dealer lot: two rows of cars nose-out to the avenue and the aisle, painted bays */
function lot(ctx: BCtx, slot: CSlot, x0: number, x1: number, z0: number, z1: number, e: number, r: Rng) {
  const lines = flat('#f2f0e8', 0.7);
  const rowsX = [e > 0 ? x1 - 3.3 : x0 + 3.3, e > 0 ? x0 + 3.3 : x1 - 3.3];
  for (const [i, x] of rowsX.entries()) {
    for (let z = z0 + 1.6; z < z1 - 1.4; z += 3.0) {
      const l = new THREE.Mesh(new THREE.BoxGeometry(5.4, 0.01, 0.1), lines);
      l.position.set(x, CURB + 0.02, z - 1.5);
      l.userData.owned = true;
      ctx.stat.add(l);
      if (r.chance(0.12)) continue; // an empty bay
      slot({ kind: i === 0 ? ['carShow', 'car'] : ['car', 'car', 'truck', 'bike'], x, y: CURB + 0.02, z, rot: (e > 0) === (i === 0) ? 0 : Math.PI, w: 5.8, d: 2.75, h: 3.2, min: i === 0 ? 3.4 : 1.6, radius: 90, maxTris: 150_000 });
    }
  }
}

/** a string of coloured triangular pennants between two points */
function pennants(ctx: BCtx, xa: number, za: number, xb: number, zb: number, y: number) {
  const n = Math.max(2, Math.round(Math.hypot(xb - xa, zb - za) / 0.6));
  const pos: number[] = [], col: number[] = [];
  const cols = ['#d62828', '#f7c600', '#1d5fd6', '#ffffff', '#2a9d3c'].map((c) => new THREE.Color(c));
  for (let i = 0; i < n; i++) {
    const t = i / n, t2 = (i + 0.7) / n;
    const sag = (u: number) => -Math.sin(u * Math.PI) * 0.8;
    const ax = xa + (xb - xa) * t, az = za + (zb - za) * t, bx = xa + (xb - xa) * t2, bz = za + (zb - za) * t2;
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    pos.push(ax, y + sag(t), az, bx, y + sag(t2), bz, mx, y + sag((t + t2) / 2) - 0.4, mz);
    const c = cols[i % cols.length];
    for (let k = 0; k < 3; k++) col.push(c.r, c.g, c.b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.8 }));
  m.userData.owned = true;
  ctx.group.add(m);
}
