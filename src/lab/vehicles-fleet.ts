import * as THREE from 'three';
import type { LabScene } from '../lab';
import { FLEET, FLEET_LOD, fleetInstances, nearObject, paintMat, preloadFleet, ready } from '../nyc/vehicleFleet';

/**
 * ?lab=vehicles-fleet — every fleet model in a row, noses toward -z.
 * &paint=%23ff00ff tints the paint (to check which parts are paint); &lod=1|2 forces the instanced mid/far LOD;
 * &only=id,id limits the row; &spin=<rad> turns the cut-out wheels; &brake=1 lights the brake lamps.
 */
let cam: THREE.Camera | null = null;
const scene: LabScene = {
  name: 'vehicles-fleet',
  description: 'all GLB fleet cars in a row (&paint=, &lod=1|2, &only=, &spin=, &brake=1)',
  cam: [-14, 3.5, -16],
  look: [0, 0.8, 0],
  env: 'nyc',
  async build({ group, params, camera }) {
    cam = camera;
    await preloadFleet();
    const only = params.get('only')?.split(',');
    const ids = Object.keys(FLEET).filter((id) => !only || only.includes(id));
    const forced = params.get('lod');
    if (forced === '1') Object.assign(FLEET_LOD, { NEAR: 0, MID: 1e9 });
    if (forced === '2') Object.assign(FLEET_LOD, { NEAR: 0, MID: 0 });
    const paint = paintMat(params.get('paint') ?? '#1f3558', 0.6);
    group.add(fleetInstances.root);
    let tris = 0;
    ids.forEach((id, i) => {
      const p = ready.get(id);
      if (!p) return;
      const o = new THREE.Group();
      const { near, wheels, brake } = nearObject(p, paint);
      o.add(near);
      if (brake) {
        brake.visible = params.has('brake');
        o.add(brake);
      }
      for (const w of wheels) w.rotation.x = Number(params.get('spin') ?? 0);
      o.position.x = (i - (ids.length - 1) / 2) * 2.8;
      group.add(o);
      fleetInstances.register(o, id, paint.color, near);
      for (const part of forced === '1' ? p.lod1 : forced === '2' ? p.lod2 : p.lod0) tris += (part.geo.index?.count ?? 0) / 3;
    });
    fleetInstances.update(camera.position);
    (window as any).__fleetTris = tris;
    (window as any).__fleet = ready;
  },
  update() {
    if (cam) fleetInstances.update(cam.position);
  },
};
export default scene;
