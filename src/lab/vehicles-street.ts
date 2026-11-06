import * as THREE from 'three';
import type { LabScene } from '../lab';
import { carMesh } from '../nyc/vehicles';
import { fleetInstances, preloadAll } from '../nyc/vehicleFleet';
import { Rng } from '../rng';

/**
 * ?lab=vehicles-street — a 240 m avenue's worth of cars, for counts: parked cars every ~7 m on both kerbs
 * (~70) and 26 cars/buses/trucks in three lanes, camera at eye height on the sidewalk.
 * window.__vehStats() returns the renderer's draw calls / triangles for the last frame and the LOD census.
 */
let cam: THREE.Camera | null = null;
const scene: LabScene = {
  name: 'vehicles-street',
  description: 'parked + moving cars along a 240 m avenue (counts: __vehStats())',
  cam: [5.1, 1.65, 14],
  look: [0, 1.2, -30],
  env: 'nyc',
  ground: true,
  async build({ group, renderer, params, camera }) {
    await preloadAll();
    cam = camera;
    group.add(fleetInstances.root);
    const r = new Rng(Number(params.get('seed') ?? 7));
    for (const side of [-1, 1])
      for (let z = -120; z < 120; z += r.range(6.5, 8)) {
        const car = carMesh(r.chance(0.15) ? 'cab' : 'sedan', r);
        car.position.set(side * 6.6, 0, z);
        car.rotation.y = r.chance(0.5) ? Math.PI : 0;
        group.add(car);
      }
    for (let i = 0; i < 26; i++) {
      const kind = r.chance(0.07) ? 'bus' : r.chance(0.07) ? 'truck' : r.chance(0.5) ? 'cab' : 'sedan';
      const car = carMesh(kind, r);
      car.position.set([-3.6, 0, 3.6][i % 3], 0, -110 + i * 8.5 + r.range(-1, 1));
      group.add(car);
    }
    (window as any).__vehStats = () => {
      // triangles in the scene graph that are drawn (visible meshes; instanced counted per instance)
      let tris = 0, meshes = 0;
      group.traverseVisible((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        meshes++;
        const n = (m.geometry.index?.count ?? m.geometry.getAttribute('position').count) / 3;
        tris += (m as THREE.InstancedMesh).isInstancedMesh ? n * (m as THREE.InstancedMesh).count : n;
      });
      return { ...renderer.info.render, cars: fleetInstances.census, sceneTris: Math.round(tris), meshes };
    };
  },
  update() {
    if (cam) fleetInstances.update(cam.position);
  },
};
export default scene;
