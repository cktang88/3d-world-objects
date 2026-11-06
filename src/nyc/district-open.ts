import * as THREE from 'three';
import type { Portal, Rect } from '../level';
import { rect } from '../level';
import { Rng, hashN } from '../rng';
import { AX, SZ, AVE, ST, BX, BZ, LX, LZ, CURB, B, M, bake, avenueName, streetName } from './common';
import { signalPole, nameSign, lampPost, hydrant } from './streetprops';
import { roadOpen, type District, type Edge } from './districts';
import { buildPark } from './district-park';
import { buildWater } from './district-water';
import { buildAirport } from './district-airport';

/**
 * Open chunks (park, airport, river, piers): the roads around them stay only where a neighbour is
 * built up; where two open chunks meet the road is gone and the open ground runs through. This
 * module lays the remaining road strips (with the city's road texture), sidewalks, kerbs, corner
 * signals and lamps, then hands the inside to the district's builder.
 */

export interface OpenCtx {
  d: District;
  cx: number;
  cz: number;
  rng: Rng;
  seed: number;
  group: THREE.Group;
  /** merged at the end */
  stat: THREE.Group;
  colliders: Rect[];
  portals: Portal[];
  /** which edges still have a road */
  open: Record<Edge, boolean>;
  /** the area inside the remaining sidewalks (local coordinates) */
  inner: Rect;
}

/** a piece of the road plane with the city road texture lined up as on a full block */
function roadStrip(m: THREE.Material, x0: number, x1: number, z0: number, z1: number) {
  const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
  g.rotateX(-Math.PI / 2);
  g.translate((x0 + x1) / 2, 0, (z0 + z1) / 2);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) uv.setXY(i, 0.5 + p.getX(i) / AX, 0.5 - p.getZ(i) / SZ);
  const mesh = new THREE.Mesh(g, m);
  mesh.receiveShadow = true;
  mesh.userData.owned = true;
  return mesh;
}
function sidewalk(stat: THREE.Object3D, x0: number, x1: number, z0: number, z1: number) {
  const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
  g.rotateX(-Math.PI / 2);
  g.translate((x0 + x1) / 2, CURB, (z0 + z1) / 2);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / 3, -p.getZ(i) / 3);
  stat.add(new THREE.Mesh(g, M.sidewalk()));
}

export function openChunk(d: District, cx: number, cz: number, seed: number, roadMaterial: THREE.Material) {
  const rng = new Rng(hashN(seed, 17));
  const group = new THREE.Group();
  const stat = new THREE.Group();
  const colliders: Rect[] = [];
  const portals: Portal[] = [];
  const open: Record<Edge, boolean> = { '+x': roadOpen(cx, cz, '+x'), '-x': roadOpen(cx, cz, '-x'), '+z': roadOpen(cx, cz, '+z'), '-z': roadOpen(cx, cz, '-z') };
  const inner: Rect = {
    minX: open['-x'] ? -LX : -AX / 2,
    maxX: open['+x'] ? LX : AX / 2,
    minZ: open['-z'] ? -LZ : -SZ / 2,
    maxZ: open['+z'] ? LZ : SZ / 2,
  };
  const ctx: OpenCtx = { d, cx, cz, rng, seed, group, stat, colliders, portals, open, inner };

  // roads: each open edge keeps its half of the roadway (and the corner squares with it)
  const ha = AVE / 2, hs = ST / 2;
  const curb = M.curb();
  if (open['+x']) group.add(roadStrip(roadMaterial, AX / 2 - ha, AX / 2, -SZ / 2, SZ / 2));
  if (open['-x']) group.add(roadStrip(roadMaterial, -AX / 2, -AX / 2 + ha, -SZ / 2, SZ / 2));
  const zx0 = open['-x'] ? -AX / 2 + ha : -AX / 2, zx1 = open['+x'] ? AX / 2 - ha : AX / 2;
  if (open['+z']) group.add(roadStrip(roadMaterial, zx0, zx1, SZ / 2 - hs, SZ / 2));
  if (open['-z']) group.add(roadStrip(roadMaterial, zx0, zx1, -SZ / 2, -SZ / 2 + hs));
  // sidewalks along the open edges, kerbs on their road side
  const kx0 = open['-x'] ? -BX : -AX / 2, kx1 = open['+x'] ? BX : AX / 2;
  const kz0 = open['-z'] ? -BZ : -SZ / 2, kz1 = open['+z'] ? BZ : SZ / 2;
  if (open['+x']) { sidewalk(stat, LX, BX, kz0, kz1); B(stat, curb, 0.25, CURB, kz1 - kz0, BX - 0.125, 0, (kz0 + kz1) / 2, false); }
  if (open['-x']) { sidewalk(stat, -BX, -LX, kz0, kz1); B(stat, curb, 0.25, CURB, kz1 - kz0, -BX + 0.125, 0, (kz0 + kz1) / 2, false); }
  const sx0 = open['-x'] ? -LX : kx0, sx1 = open['+x'] ? LX : kx1;
  if (open['+z']) { sidewalk(stat, sx0, sx1, LZ, BZ); B(stat, curb, kx1 - kx0, CURB, 0.25, (kx0 + kx1) / 2, 0, BZ - 0.125, false); }
  if (open['-z']) { sidewalk(stat, sx0, sx1, -BZ, -LZ); B(stat, curb, kx1 - kx0, CURB, 0.25, (kx0 + kx1) / 2, 0, -BZ + 0.125, false); }

  // corners where two roads meet: signals and street names
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const ex: Edge = sx > 0 ? '+x' : '-x', ez: Edge = sz > 0 ? '+z' : '-z';
    if (!open[ex] || !open[ez]) continue;
    const x = sx * (BX - 0.9), z = sz * (BZ - 0.9);
    signalPole(stat, x, z, sx, sz);
    colliders.push(rect(x, z, 0.5, 0.5));
    stat.add(nameSign(streetName(cz + (sz > 0 ? 0 : -1)), x, CURB + 6.32, z, 0));
    stat.add(nameSign(avenueName(cx + (sx > 0 ? 0 : -1)), x, CURB + 6.6, z, Math.PI / 2));
  }
  // street lights and a hydrant along each open sidewalk
  const lampStyle = d.open === 'park' ? 'crook' : 'cobra';
  for (const e of ['+x', '-x', '+z', '-z'] as Edge[]) {
    if (!open[e]) continue;
    const alongX = e === '+z' || e === '-z';
    const s = e[0] === '+' ? 1 : -1;
    const c = alongX ? s * (BZ - 0.7) : s * (BX - 0.7);
    const from = alongX ? kx0 + 4 : kz0 + 4, to = alongX ? kx1 - 4 : kz1 - 4;
    for (let t = from + 3; t < to; t += 26) {
      const [x, z] = alongX ? [t, c] : [c, t];
      lampPost(stat, group, x, z, alongX ? 'x' : 'z', s, lampStyle);
      colliders.push(rect(x, z, 0.4, 0.4));
    }
    if (rng.chance(0.6)) {
      const t = rng.range(from + 5, to - 5);
      const [x, z] = alongX ? [t, c] : [c, t];
      hydrant(stat, x, z, rng);
      colliders.push(rect(x, z, 0.4, 0.4));
    }
  }

  if (d.open === 'park') buildPark(ctx);
  else if (d.open === 'airport') buildAirport(ctx);
  else buildWater(ctx);

  const baked = bake(stat);
  group.add(baked);
  stat.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.userData.owned) m.geometry.dispose();
  });
  return { group, colliders, portals };
}
