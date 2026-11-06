import * as THREE from 'three';
import type { LabScene } from '../lab';
import { FLEET, fleetObject, paintMat, preloadFleet, ready } from '../nyc/vehicleFleet';

/**
 * ?lab=vehicles-fleet — every fleet model in a row, noses toward -z.
 * &paint=%23ff00ff tints the paint material (to check which parts are paint); &lod=1 forces the far LOD;
 * &only=id,id limits the row.
 */
const scene: LabScene = {
  name: 'vehicles-fleet',
  description: 'all GLB fleet cars in a row (&paint=, &lod=1, &only=)',
  cam: [-14, 3.5, -16],
  look: [0, 0.8, 0],
  env: 'nyc',
  async build({ group, params }) {
    await preloadFleet();
    const only = params.get('only')?.split(',');
    const ids = Object.keys(FLEET).filter((id) => !only || only.includes(id));
    const forced = params.get('lod');
    const paint = paintMat(params.get('paint') ?? '#1f3558', 0.6);
    ids.forEach((id, i) => {
      const p = ready.get(id);
      if (!p) return;
      const o = fleetObject(p, paint);
      if (forced) {
        o.autoUpdate = false;
        o.levels.forEach((l, k) => (l.object.visible = k === Number(forced)));
      }
      o.position.x = (i - (ids.length - 1) / 2) * 2.8;
      // &spin=<rad> turns the cut-out wheels, to check they were cut cleanly
      for (const w of (o.userData.wheels ?? []) as THREE.Object3D[]) w.rotation.x = Number(params.get('spin') ?? 0);
      // &brake=1 lights the brake lamps
      if (o.userData.brake) o.userData.brake.visible = params.has('brake');
      group.add(o);
    });
    let tris = 0;
    group.traverse((m) => {
      const mesh = m as THREE.Mesh;
      if (mesh.isMesh && mesh.visible) tris += (mesh.geometry.index?.count ?? 0) / 3;
    });
    (window as any).__fleetTris = tris;
    (window as any).__fleet = ready;
  },
};
export default scene;
