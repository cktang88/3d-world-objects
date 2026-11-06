/**
 * What a car looks like at each distance: before its model loads a stand-in car silhouette (not a box), then
 * near LOD (< FLEET_LOD.NEAR, once the near file is in), instanced mid (< MID), instanced far beyond.
 */
import * as THREE from 'three';
import { test, expect, between } from './qa';
import './env';
import { FLEET, FLEET_LOD, fleetLevel } from '../src/nyc/vehicleFleet';
import { carMesh, standin } from '../src/nyc/vehicles';
import { Rng } from '../src/rng';

test('car representation by distance: near < 12 m (when loaded), mid < 40 m, far beyond', () => {
  expect(FLEET_LOD.NEAR < FLEET_LOD.MID, 'NEAR < MID');
  expect(fleetLevel(5, true) === 'near', '5 m, near file loaded: near LOD');
  expect(fleetLevel(5, false) === 'mid', '5 m, near file not loaded yet: mid LOD');
  expect(fleetLevel(FLEET_LOD.NEAR + 0.1, true) === 'mid', 'just past NEAR: mid');
  expect(fleetLevel(FLEET_LOD.MID - 0.1, true) === 'mid', 'just inside MID: mid');
  expect(fleetLevel(FLEET_LOD.MID + 0.1, true) === 'far', 'past MID: far LOD (a real model, not a proxy box)');
  expect(fleetLevel(300, true) === 'far', '300 m: far LOD');
});

test('before its model loads a car is a car-shaped stand-in (tapered cabin over a body, wheels), not a box', () => {
  for (const [id, f] of Object.entries(FLEET)) {
    const tall = /tahoe|suburban|explorer|escalade|sprinter/.test(id);
    const s = standin('#3a5a8a', f.len, f.wid, tall);
    let tris = 0;
    s.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) tris += (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute('position').count) / 3;
    });
    expect(tris > 60, `${id} stand-in has ${tris} triangles (a box has 12)`);
    const b = new THREE.Box3().setFromObject(s), sz = b.getSize(new THREE.Vector3());
    between(sz.z, f.len * 0.95, f.len * 1.02, `${id} stand-in length`);
    between(sz.x, f.wid * 0.9, f.wid * 1.02, `${id} stand-in width`);
    between(sz.y, tall ? 1.7 : 1.3, tall ? 2.0 : 1.6, `${id} stand-in height`);
    // the roof is shorter than the body (a cabin, not a box): measure the vertices in the top 10 cm
    let zmin = Infinity, zmax = -Infinity;
    s.updateMatrixWorld(true);
    s.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const p = m.geometry.getAttribute('position'), v = new THREE.Vector3();
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
        if (v.y > b.max.y - 0.1) { zmin = Math.min(zmin, v.z); zmax = Math.max(zmax, v.z); }
      }
    });
    expect(zmax - zmin < f.len * (tall ? 0.75 : 0.55), `${id} roof ${(zmax - zmin).toFixed(2)} m long on a ${f.len} m car`);
  }
  // street cars created before loading carry the stand-in, nose toward -z (the hood is lower than the roof at the front)
  const car = carMesh('sedan', new Rng(3));
  let standins = 0;
  car.traverse((o) => o.userData.standin && standins++);
  expect(standins === 1, 'an unloaded street car shows one stand-in');
});
