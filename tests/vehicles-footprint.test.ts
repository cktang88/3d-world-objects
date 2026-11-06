/**
 * The car you see is the car the simulation avoids: every fleet model's loaded geometry (near and mid LOD,
 * as placed in a car: the fleet's scale, rotation and pivot) has the footprint length, width and centre
 * that traffic spacing and pedestrian avoidance use (Car.rect from FLEET len/wid about the car's origin).
 */
import * as THREE from 'three';
import { test, expect, fmt } from './qa';
import { allowModels, settle } from './env';

test('fleet models match their simulation footprint (length, width, centre) within 10 cm', async () => {
  allowModels(/assets\/vehicles\//);
  const { FLEET, preloadFleet, ready, loadNear, footprintOf } = await import('../src/nyc/vehicleFleet');
  await preloadFleet();
  await settle(0);
  const bad: string[] = [];
  const rows: string[] = [];
  for (const id of Object.keys(FLEET)) {
    let p = ready.get(id);
    if (!p) continue;
    if (!p.nearReady) p = (await loadNear(id)) ?? p;
    for (const [lod, parts] of [['near', p.lod0], ['mid', p.lod1]] as const) {
      if (!parts?.length) continue;
      const b = new THREE.Box3();
      for (const part of parts) {
        part.geo.computeBoundingBox();
        b.union(part.geo.boundingBox!);
      }
      // the car's footprint in its own frame: length along z (nose toward -z), width along x, centred
      const len = b.max.z - b.min.z, wid = b.max.x - b.min.x, cz = (b.max.z + b.min.z) / 2, cx = (b.max.x + b.min.x) / 2;
      const f = footprintOf(id);
      rows.push(`${id} ${lod}: ${fmt(len)} x ${fmt(wid)} m, centre ${fmt(cx)},${fmt(cz)} (footprint ${fmt(f.len)} x ${fmt(f.wid)} at ${fmt(f.cx)},${fmt(f.cz)}; FLEET ${FLEET[id].len} x ${FLEET[id].wid})`);
      // the footprint holds the model (2 cm slack), and is no more than 10 cm larger than it
      const fb = { minX: f.cx - f.wid / 2, maxX: f.cx + f.wid / 2, minZ: f.cz - f.len / 2, maxZ: f.cz + f.len / 2 };
      const outside = Math.max(fb.minX - b.min.x, b.max.x - fb.maxX, fb.minZ - b.min.z, b.max.z - fb.maxZ);
      if (outside > 0.02) bad.push(`${id} ${lod}: the model reaches ${fmt(outside)} m outside its footprint`);
      if (f.len - len > 0.1 || f.wid - wid > 0.15) bad.push(`${id} ${lod}: footprint ${fmt(f.len)} x ${fmt(f.wid)} much larger than the model ${fmt(len)} x ${fmt(wid)}`);
    }
  }
  console.log('   ' + rows.join('\n   '));
  expect(rows.length > 0, 'no fleet model loaded');
  expect(!bad.length, bad.join('\n'));
});

test('a traffic car\'s rect covers its model as placed (rotation and centre offset applied)', async () => {
  allowModels(/assets\/vehicles\//);
  const { preloadFleet } = await import('../src/nyc/vehicleFleet');
  const { Traffic } = await import('../src/nyc/vehicles');
  await preloadFleet();
  await settle(0);
  const tr = new Traffic(new THREE.Group(), 4);
  tr.update(0.1, new THREE.Vector3(0, 1.7, 0), 0);
  await settle(0);
  tr.update(0.1, new THREE.Vector3(0, 1.7, 0), 0.1);
  const bad: string[] = [];
  let n = 0;
  for (const c of tr.cars) {
    const body = c.obj.children.find((o) => !o.userData.standin && o.visible);
    void body;
    // the model's world box from its mid LOD geometry as placed: use the car's own transform
    c.obj.updateMatrixWorld(true);
    const { footprintOf, ready } = await import('../src/nyc/vehicleFleet');
    const id = c.obj.userData.model as string;
    const p = id && ready.get(id);
    if (!p) continue;
    const b = new THREE.Box3();
    for (const part of p.lod1) b.union(part.geo.boundingBox!.clone().applyMatrix4(c.obj.matrixWorld));
    const r = c.rect;
    n++;
    // the rect holds the model as placed (2 cm slack) and is at most 15 cm wider (mirrors of the other LOD)
    const off = Math.max(r.minX - b.min.x, b.max.x - r.maxX, r.minZ - b.min.z, b.max.z - r.maxZ, (r.maxX - r.minX) - (b.max.x - b.min.x) - 0.13, (r.maxZ - r.minZ) - (b.max.z - b.min.z) - 0.13);
    if (off > 0.02) bad.push(`${id} (${c.axis}, dir ${c.dir}): rect off the model by ${fmt(off)} m (footprint ${JSON.stringify(footprintOf(id))})`);
  }
  expect(n > 10, `only ${n} dressed cars`);
  expect(!bad.length, bad.slice(0, 6).join('\n'));
});
