import type * as THREE from 'three';
import type { LabScene } from '../lab';
import { districtLab } from '../nyc/district-lab';
import { Waterfront } from '../nyc/waterfront';

/**
 * [nbhd] ?lab=waterfront — the Hudson River Park esplanade and a pier at eye height, with the open river and the
 * New Jersey shore (Waterfront): &cz= picks the pier (0 shed, 1 park pier, 2 marina), &rcam= / &rlook= as in district labs.
 */
const base = districtLab('waterfront', 'Hudson River Park esplanade, a pier, the open river and the Jersey shore (&cz=)', 6, -1, [-18, 1.75, 24], [40, 0.5, 4], [0, 1]);
const far = new Waterfront();
let cam: THREE.Camera | null = null;
const scene: LabScene = {
  ...base,
  async build(a) {
    await base.build(a);
    cam = a.camera;
    a.group.add(far.group);
    far.update(0, a.camera.position);
  },
  update(dt, time) {
    base.update?.(dt, time);
    if (cam) far.update(time, cam.position);
  },
};
export default scene;
