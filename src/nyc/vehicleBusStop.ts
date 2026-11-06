import { onRamp } from './ground';
import * as THREE from 'three';
import { mat } from '../build';
import type { Rect } from '../level';
import { B, C, BX, canvasTex } from './common';
import { SPAWN } from './districts';

/**
 * The 5 Av kerb at the spawn is an MTA bus stop (no standing for ~42 m), so the first view looks across an empty
 * kerb lane at the avenue's traffic instead of into a parked van. Block-local coordinates of chunk (0,0).
 */
export const SPAWN_BUS_STOP = { x: BX + 1.15, z0: SPAWN.z - 36, z1: SPAWN.z + 6 };
export function noParking(cx: number, cz: number, x: number, z: number) {
  const s = SPAWN_BUS_STOP;
  return cx === 0 && cz === 0 && Math.abs(x - s.x) < 1.6 && z > s.z0 - 2.5 && z < s.z1 + 2.5;
}

/** the bus stop's kerb-side paint (dashed box + BUS STOP letters) and its blue MTA sign pole */
export function busStop(parent: THREE.Object3D, colliders: Rect[]) {
  const s = SPAWN_BUS_STOP;
  const paint = mat('#e9e6dc', { rough: 0.7 });
  const g = new THREE.Group();
  const L = s.z1 - s.z0;
  // dashed outer line of the zone and its two ends
  for (let z = s.z0; z < s.z1; z += 1.2) B(g, paint, 0.12, 0.012, 0.6, s.x + 1.2, 0, z + 0.3, false);
  B(g, paint, 2.6, 0.012, 0.12, s.x, 0, s.z0, false);
  B(g, paint, 2.6, 0.012, 0.12, s.x, 0, s.z1, false);
  // BUS STOP letters, reading for drivers heading north (-z)
  const letters = new THREE.MeshStandardMaterial({
    map: canvasTex(256, 512, (c) => {
      c.clearRect(0, 0, 256, 512);
      c.fillStyle = '#ece9df';
      c.font = 'bold 150px Arial';
      c.textAlign = 'center';
      c.fillText('BUS', 128, 200, 250);
      c.fillText('STOP', 128, 400, 250);
    }),
    transparent: true,
    roughness: 0.7,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    depthWrite: false,
  });
  const word = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 3.6), letters);
  word.rotation.x = -Math.PI / 2;
  word.position.set(s.x, 0.015, s.z0 + L * 0.3);
  g.add(word);
  // sign pole at the head of the stop, on the sidewalk by the kerb
  // keep the pole off the corner kerb ramp (the stop's head reaches the corner)
  const px = BX - 0.45;
  let pz = s.z0 + 1.5;
  while (onRamp(px, pz, 0.2, 0.2) && pz < s.z1) pz += 0.5;
  C(g, mat('#3c4a42', { metal: 0.5, rough: 0.5 }), 0.035, 3.0, px, 0.15, pz);
  const face = new THREE.MeshStandardMaterial({
    map: canvasTex(128, 256, (c) => {
      c.fillStyle = '#1748a3';
      c.fillRect(0, 0, 128, 256);
      c.fillStyle = '#fff';
      c.textAlign = 'center';
      c.font = 'bold 30px Arial';
      c.fillText('MTA', 64, 40);
      c.font = 'bold 22px Arial';
      c.fillText('BUS STOP', 64, 80);
      c.fillRect(14, 100, 100, 54);
      c.fillStyle = '#1748a3';
      c.font = 'bold 40px Arial';
      c.fillText('M1', 64, 142);
      c.fillStyle = '#fff';
      c.font = '18px Arial';
      c.fillText('M2  M3  M4', 64, 190);
      c.fillText('5 Av', 64, 226);
    }),
    roughness: 0.4,
  });
  const sign = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.9, 0.46), face);
  sign.position.set(px, 2.7, pz);
  sign.castShadow = true;
  g.add(sign);
  g.traverse((o) => (o.userData.owned = false));
  parent.add(g);
  colliders.push({ minX: px - 0.1, maxX: px + 0.1, minZ: pz - 0.1, maxZ: pz + 0.1 });
}
