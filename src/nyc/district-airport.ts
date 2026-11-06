import * as THREE from 'three';
import { rect } from '../level';
import { Rng, hashN } from '../rng';
import { AX, SZ, CURB } from './common';
import { kit, place, PM } from './streetprops';
import { mat } from '../build';
import { addSlot, type SlotSpec } from './district-showcase';
import { apronMat, flat, slab, ellipse } from './district-tex';
import { chainFence } from './district-props';
import type { OpenCtx } from './district-open';

/**
 * A LaGuardia-style airport edge (docs/research/districts.md): concrete apron slabs with yellow
 * taxi lines and stand lead-ins, a barrel-roofed hangar, airliner stands with jet bridges, a
 * general-aviation ramp with a helipad, baggage-cart trains and tugs, behind a perimeter fence.
 * Aircraft and ground vehicles are sand3d showcase objects (aircraft/spacecraft, vehicle families).
 */

const Y = CURB * 0.5;
type Kind = 'stands' | 'hangar' | 'ramp';

export function buildAirport(c: OpenCtx) {
  const { inner, stat, group, colliders, open } = c;
  const r = new Rng(hashN(c.seed, 41));
  const slot = (s: Omit<SlotSpec, 'seed'>, col = true) => {
    addSlot(group, c.portals, { ...s, seed: hashN(c.seed, Math.round(s.x * 10), Math.round(s.z * 10)) });
    if (col) colliders.push(rect(s.x, s.z, Math.min(s.w, s.d) * 0.25, Math.max(s.w, s.d) * 0.6));
  };
  stat.add(slab(apronMat(), inner.minX, inner.maxX, inner.minZ, inner.maxZ, Y, 20));
  // perimeter fence along every street, 3 m with barbed-wire outriggers
  for (const e of ['+x', '-x', '+z', '-z'] as const) {
    if (!open[e]) continue;
    const alongX = e[1] === 'z', s = e[0] === '+' ? 1 : -1;
    const line = (alongX ? (s > 0 ? inner.maxZ : inner.minZ) : s > 0 ? inner.maxX : inner.minX) - s * 0.4;
    if (alongX) chainFence(stat, inner.minX, line, inner.maxX, line, 3, CURB);
    else chainFence(stat, line, inner.minZ, line, inner.maxZ, 3, CURB);
    colliders.push(alongX ? { minX: inner.minX, maxX: inner.maxX, minZ: line - 0.2, maxZ: line + 0.2 } : { minX: line - 0.2, maxX: line + 0.2, minZ: inner.minZ, maxZ: inner.maxZ });
  }
  // a taxiway centreline along the chunk (x) with blue edge lights
  const yellow = flat('#e8b81a', 0.6);
  stat.add(slab(flat('#55575a', 0.9), inner.minX, inner.maxX, -SZ / 2 + 2, -SZ / 2 + 22, Y + 0.005, 6)); // asphalt taxiway
  stat.add(slab(yellow, inner.minX, inner.maxX, -SZ / 2 + 11.9, -SZ / 2 + 12.1, Y + 0.012, 1));
  const blue = new THREE.MeshStandardMaterial({ color: '#2a5cff', emissive: '#2a5cff', emissiveIntensity: 1.5 });
  for (let x = Math.ceil(inner.minX / 15) * 15; x < inner.maxX; x += 15)
    for (const z of [-SZ / 2 + 2.5, -SZ / 2 + 21.5]) {
      const l = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.35, 6), blue);
      l.position.set(x, Y + 0.17, z);
      stat.add(l);
    }

  const kind: Kind = (['stands', 'hangar', 'ramp'] as Kind[])[((c.cz % 3) + 3 + (c.cx & 1)) % 3];
  const az = 10; // the stand area's centre z
  if (kind === 'stands') {
    // two stands: lead-in lines, stop bars, a jet bridge from a terminal wall at the back
    for (const sx of [-1, 1]) {
      const x = sx * 28;
      stat.add(slab(yellow, x - 0.1, x + 0.1, -SZ / 2 + 12, SZ / 2 - 8, Y + 0.012, 1));
      stat.add(slab(flat('#c22a2a', 0.6), x - 3, x + 3, SZ / 2 - 9, SZ / 2 - 8.6, Y + 0.012, 1));
      slot({ kind: ['planeStand', 'plane'], x, y: Y, z: az, rot: Math.PI / 2, w: 58, d: 56, h: 18, min: 12, radius: 260, maxTris: 600_000 });
      jetBridge(stat, x + 4, SZ / 2 - 4, sx);
      // a tug and a baggage-cart train beside each stand
      slot({ kind: 'truck', x: x + sx * 6, y: Y, z: az - 24.5, rot: 0, w: 8, d: 3, h: 3.5, min: 2.5, radius: 120, maxTris: 150_000 });
      baggageTrain(stat, colliders, x - sx * 18, az - 4, Math.PI / 2, r.int(3, 4));
    }
    terminal(stat, colliders, inner.minX, inner.maxX, SZ / 2 - 4);
  } else if (kind === 'hangar') {
    hangar(stat, colliders, 0, 8, 60, 34);
    slot({ kind: ['plane', 'heli'], x: 0, y: Y, z: 8, rot: 0, w: 40, d: 26, h: 12, min: 8, radius: 220, maxTris: 500_000 }, false);
    slot({ kind: 'space', x: -38, y: Y, z: 12, rot: 0, w: 14, d: 14, h: 25, min: 3, radius: 220, maxTris: 300_000 });
    slot({ kind: 'truck', x: 38, y: Y, z: 14, rot: Math.PI / 2, w: 9, d: 3.2, h: 4, min: 2.5, radius: 120, maxTris: 150_000 });
    baggageTrain(stat, colliders, 40, -2, 0, 3);
  } else {
    // general aviation: small planes tied down in a row, a helipad
    for (let i = 0; i < 4; i++) {
      const x = -45 + i * 18;
      stat.add(slab(yellow, x - 0.08, x + 0.08, az - 4, az + 12, Y + 0.012, 1));
      slot({ kind: 'plane', x, y: Y, z: az + 3, rot: Math.PI / 2, w: 17, d: 15, h: 6, min: 5, radius: 200, maxTris: 300_000 });
    }
    stat.add(ellipse(flat('#3d4a3d', 0.85), 38, az + 2, 10, 10, Y + 0.01, 4));
    stat.add(ellipse(flat('#f2f2ec', 0.6), 38, az + 2, 9.2, 9.2, Y + 0.012, 4));
    stat.add(ellipse(flat('#3d4a3d', 0.85), 38, az + 2, 8.6, 8.6, Y + 0.014, 4));
    for (const [w, d, dx, dz] of [[0.8, 6, -2, 0], [0.8, 6, 2, 0], [4, 0.8, 0, 0]] as const) stat.add(slab(flat('#f2f2ec', 0.6), 38 + dx - w / 2, 38 + dx + w / 2, az + 2 + dz - d / 2, az + 2 + dz + d / 2, Y + 0.016, 1));
    slot({ kind: 'heli', x: 38, y: Y, z: az + 2, rot: 0, w: 17, d: 15, h: 6, min: 5, radius: 200, maxTris: 300_000 }, false);
    windsock(stat, 50, SZ / 2 - 6);
  }
  void AX;
}

/** baggage carts behind a tug (kit), from (x, z) running along yaw */
function baggageTrain(stat: THREE.Object3D, colliders: OpenCtx['colliders'], x: number, z: number, ry: number, n: number) {
  const cart = kit('bag-cart', (k) => {
    k.add(new THREE.BoxGeometry(1.5, 0.12, 3), PM.galvDark(), 0, 0.45, 0);
    k.add(new THREE.BoxGeometry(1.5, 1.3, 2.9), mat('#2b4f8f', { rough: 0.85 }), 0, 1.15, 0);
    k.add(new THREE.BoxGeometry(1.6, 0.08, 3.05), mat('#d9d9d6', { rough: 0.6 }), 0, 1.84, 0);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.add(new THREE.CylinderGeometry(0.2, 0.2, 0.12, 10), mat('#1a1a1a', { rough: 0.9 }), sx * 0.7, 0.2, sz * 1.1, 0, 0, Math.PI / 2);
    k.add(new THREE.BoxGeometry(0.05, 0.05, 0.9), PM.galv(), 0, 0.4, -1.9);
  });
  const tug = kit('bag-tug', (k) => {
    k.add(new THREE.BoxGeometry(1.5, 0.8, 2.6), mat('#e0e0dc', { rough: 0.6 }), 0, 0.7, 0);
    k.add(new THREE.BoxGeometry(1.3, 1.0, 0.9), mat('#e0e0dc', { rough: 0.6 }), 0, 1.5, 0.5);
    k.add(new THREE.BoxGeometry(1.32, 0.5, 0.05), mat('#1e2a33', { rough: 0.1 }), 0, 1.7, 0.05);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.add(new THREE.CylinderGeometry(0.3, 0.3, 0.2, 12), mat('#1a1a1a', { rough: 0.9 }), sx * 0.7, 0.3, sz * 0.9, 0, 0, Math.PI / 2);
  });
  const dx = Math.sin(ry), dz = Math.cos(ry);
  place(stat, tug, x, Y, z, ry);
  for (let i = 1; i <= n; i++) place(stat, cart, x - dx * (i * 3.7 + 0.3), Y, z - dz * (i * 3.7 + 0.3), ry);
  const len = n * 3.7 + 3;
  const cx = x - dx * (len / 2 - 1.3), cz = z - dz * (len / 2 - 1.3);
  colliders.push(Math.abs(dx) > 0.5 ? rect(cx, cz, len, 1.8) : rect(cx, cz, 1.8, len));
}

/** a jet bridge from the terminal (at z0) reaching out to a stand */
function jetBridge(stat: THREE.Object3D, x: number, z0: number, s: number) {
  const len = 22;
  const tube = new THREE.Mesh(new THREE.BoxGeometry(3, 2.8, len), flat('#c9ccce', 0.5, 0.4));
  tube.position.set(x, 5.2, z0 - len / 2);
  tube.rotation.y = s * 0.25;
  tube.castShadow = true;
  tube.userData.owned = true;
  stat.add(tube);
  const leg = new THREE.Mesh(new THREE.BoxGeometry(0.5, 4, 0.5), flat('#6a6e72', 0.6, 0.5));
  leg.position.set(x + Math.sin(s * 0.25) * -len * 0.8, Y + 2, z0 - Math.cos(0.25) * len * 0.8);
  leg.userData.owned = true;
  stat.add(leg);
}

/** the terminal's apron face: glass curtain wall over a service level, along x at z */
function terminal(stat: THREE.Object3D, colliders: OpenCtx['colliders'], x0: number, x1: number, z: number) {
  const base = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 4, 8), flat('#b9b7b0', 0.8));
  base.position.set((x0 + x1) / 2, Y + 2, z + 4);
  base.userData.owned = true;
  stat.add(base);
  const glass = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 6, 8), flat('#5d7486', 0.12, 0.5));
  glass.position.set((x0 + x1) / 2, Y + 7, z + 4);
  glass.userData.owned = true;
  stat.add(glass);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 0.6, 10), flat('#e3e1da', 0.6));
  roof.position.set((x0 + x1) / 2, Y + 10.3, z + 4);
  roof.userData.owned = true;
  stat.add(roof);
  colliders.push({ minX: x0, maxX: x1, minZ: z, maxZ: z + 8 });
}

/** barrel-vaulted hangar with open doors facing -z */
function hangar(stat: THREE.Object3D, colliders: OpenCtx['colliders'], x: number, z: number, W: number, D: number) {
  const H = 16;
  const shell = new THREE.CylinderGeometry(W / 2, W / 2, D, 32, 1, true, -Math.PI / 2, Math.PI);
  shell.rotateX(Math.PI / 2);
  shell.scale(1, (H - 6) / (W / 2), 1);
  const m = new THREE.Mesh(shell, new THREE.MeshStandardMaterial({ color: '#9ba3a8', roughness: 0.5, metalness: 0.6, side: THREE.DoubleSide }));
  m.position.set(x, Y + 6, z + D / 2 - 2);
  m.castShadow = true;
  m.userData.owned = true;
  stat.add(m);
  for (const s of [-1, 1]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.4, 6, D), flat('#8c9499', 0.6, 0.4));
    wall.position.set(x + (s * W) / 2, Y + 3, z + D / 2 - 2);
    wall.userData.owned = true;
    stat.add(wall);
    colliders.push(rect(x + (s * W) / 2, z + D / 2 - 2, 0.6, D));
    // door leaves pushed open to the sides
    const door = new THREE.Mesh(new THREE.BoxGeometry(8, 9, 0.5), flat('#c0c6ca', 0.5, 0.5));
    door.position.set(x + s * (W / 2 - 4), Y + 4.5, z - 2);
    door.userData.owned = true;
    stat.add(door);
  }
  // back wall closing the vault
  const back = new THREE.Mesh(new THREE.CylinderGeometry(W / 2, W / 2, 0.4, 32, 1, false, -Math.PI / 2, Math.PI), flat('#7f878c', 0.7, 0.3));
  back.rotation.x = Math.PI / 2;
  back.scale.set(1, 1, (H - 6) / (W / 2));
  back.position.set(x, Y + 6, z + D - 2);
  back.userData.owned = true;
  stat.add(back);
  const backLow = new THREE.Mesh(new THREE.BoxGeometry(W, 6, 0.4), flat('#7f878c', 0.7, 0.3));
  backLow.position.set(x, Y + 3, z + D - 2);
  backLow.userData.owned = true;
  stat.add(backLow);
  colliders.push(rect(x, z + D - 2, W, 0.6));
}

function windsock(stat: THREE.Object3D, x: number, z: number) {
  const parts = kit('windsock', (k) => {
    k.add(new THREE.CylinderGeometry(0.06, 0.08, 6, 8), PM.galv(), 0, 3, 0);
    for (let i = 0; i < 5; i++) k.add(new THREE.CylinderGeometry(0.42 - i * 0.05, 0.37 - i * 0.05, 0.6, 12, 1, true), mat(i % 2 ? '#f2f2ec' : '#e8641a', { rough: 0.8 }), 0.3 + i * 0.6, 5.7 - i * 0.12, 0, 0, 0, Math.PI / 2 - 0.15);
  });
  place(stat, parts, x, Y, z, 0.7);
}
