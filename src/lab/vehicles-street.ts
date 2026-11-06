import * as THREE from 'three';
import type { LabScene } from '../lab';
import { carMesh } from '../nyc/vehicles';
import { preloadFleet } from '../nyc/vehicleFleet';
import { Rng } from '../rng';

/**
 * ?lab=vehicles-street — a 240 m avenue's worth of cars, for counts: parked cars every ~7 m on both kerbs
 * (~70) and 26 cars/buses/trucks in three lanes, camera at eye height on the sidewalk.
 * window.__vehStats() returns the renderer's draw calls / triangles for the last frame and the LOD census.
 */
const scene: LabScene = {
  name: 'vehicles-street',
  description: 'parked + moving cars along a 240 m avenue (counts: __vehStats())',
  cam: [7.2, 1.6, 30],
  look: [0, 1.0, -20],
  env: 'nyc',
  ground: true,
  async build({ group, renderer, params }) {
    await preloadFleet();
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
      const lods = [0, 0, 0];
      group.traverse((o) => {
        if ((o as THREE.LOD).isLOD) lods[(o as THREE.LOD).getCurrentLevel()]++;
      });
      return { ...renderer.info.render, lods };
    };
  },
};
export default scene;
