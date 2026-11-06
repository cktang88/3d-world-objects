/**
 * "Some cars appear to have two textures overlapping": nothing of a car may be drawn twice in the same
 * place. Every car GLB (near, mid, far LOD) has no coplanar overlapping triangles (z-fighting; see
 * scripts/coplanar-scan.mjs, which also fixes them), and a fleet car shows exactly one representation
 * (stand-in, near meshes, or one instanced LOD) at every distance and across the stand-in swap.
 */
import * as THREE from 'three';
import { test, expect } from './qa';
import { allowModels, settle } from './env';

test('car GLBs: no coplanar overlapping triangles in any LOD (z-fighting)', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const cp = await import('node:child_process');
  const dir = path.join(process.cwd(), 'public', 'assets', 'vehicles');
  const files = fs.readdirSync(dir).filter((x: string) => x.endsWith('.glb')).map((x: string) => path.join(dir, x));
  // the scanner reads GLBs with gltf-transform (its own process: the qa bundle can't load it)
  const out = cp.execFileSync(process.execPath, [path.join(process.cwd(), 'scripts', 'coplanar-scan.mjs'), ...files], { encoding: 'utf8', timeout: 120000 });
  const lines = out.split('\n').filter((l: string) => /coplanar overlapping pairs/.test(l));
  const bad = lines.filter((l: string) => !/: \d+ triangles, 0 coplanar/.test(l));
  console.log(`   ${lines.length} car GLBs scanned`);
  expect(lines.length === files.length, `scanned ${lines.length} of ${files.length}`);
  expect(!bad.length, `coplanar overlaps (fix: node scripts/coplanar-scan.mjs --fix public/assets/vehicles/*.glb):\n${bad.join('\n')}`);
});

test('a fleet car shows exactly one representation at every distance and through the swap from its stand-in', async () => {
  allowModels(/assets\/vehicles\//);
  const { carMesh } = await import('../src/nyc/vehicles');
  const { fleetInstances, preloadFleet, FLEET_LOD } = await import('../src/nyc/vehicleFleet');
  const { Rng } = await import('../src/rng');
  const scene = new THREE.Scene();
  scene.add(fleetInstances.root);
  // before the models are in: one stand-in, nothing instanced
  const early = carMesh('sedan', new Rng(5));
  scene.add(early);
  let standins = 0;
  early.traverse((o) => o.userData.standin && standins++);
  await preloadFleet();
  await settle(0);
  const cars = [early, ...Array.from({ length: 8 }, (_, i) => carMesh(i % 3 ? 'sedan' : 'cab', new Rng(100 + i)))];
  for (const c of cars) scene.add(c);
  await settle(0);
  const problems: string[] = [];
  if (standins !== 1) problems.push(`an unloaded car had ${standins} stand-ins`);
  // every car at the same distance from the eye: each must be counted in exactly one level, its near
  // meshes visible only at the near level, and no stand-in left beside the model
  const N = cars.length;
  for (const d of [3, FLEET_LOD.NEAR - 0.5, FLEET_LOD.NEAR + 0.5, FLEET_LOD.MID - 0.5, FLEET_LOD.MID + 0.5, 150]) {
    for (const c of cars) {
      c.position.set(0, 0, 0);
      c.updateMatrixWorld(true);
    }
    fleetInstances.update(new THREE.Vector3(d, 1.6, 0));
    const c = fleetInstances.census;
    if (c.near + c.mid + c.far !== N) problems.push(`at ${d} m: ${c.near} near + ${c.mid} mid + ${c.far} far for ${N} cars`);
    for (const [i, car] of cars.entries()) {
      let st = 0, nearVisible = 0;
      for (const ch of car.children) {
        if (ch.userData.standin) st++;
        else if (ch.name !== 'roof-sign' && (ch as THREE.Mesh).isMesh !== true && ch.visible && ch.children.length > 1) nearVisible++;
      }
      if (st) problems.push(`car ${i}: a stand-in is still there with the model`);
      if (d > FLEET_LOD.NEAR && nearVisible) problems.push(`car ${i} at ${d} m: near meshes drawn as well as the instanced LOD`);
    }
  }
  expect(!problems.length, problems.slice(0, 8).join('\n'));
});
