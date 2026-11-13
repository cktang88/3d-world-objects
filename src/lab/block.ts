import * as THREE from 'three';
import type { LabScene } from '../lab';
import { NycLevel } from '../nyc';
import { AX, SZ } from '../nyc/common';
import { heightGrid } from '../nyc/occlusion';
import { CityHlod } from '../nyc/hlod';
import { Waterfront } from '../nyc/waterfront';
import { updateShowcases } from '../nyc/district-showcase';
import { tickWater } from '../nyc/district-tex';
import { updateDetail } from '../detail';
import type { Hull } from '../nyc/buildings';

/**
 * ?lab=block — render only the changed block: chunk (cx, cz) built by the real generator (NycLevel.block) at its
 * world position, the camera at a world pose, instead of a full ?mode=world&r=1 shot (minutes, often crashes).
 *   &cx=&cz=           the chunk (default: the chunk under the pose, else 0,0)
 *   &pose=x,y,z,yaw[,pitch]   world eye position (y = eye height, ~1.7) and yaw as player.yaw (0 = north, -z)
 *   &ring=0|1|2        neighbours around it: 0 none (default), 1 = the 8 neighbours as HLOD proxies (cheap to draw,
 *                      still built on the CPU), 2 = the 8 neighbours as real blocks
 *   &water=0           without the open rivers and far shores (nyc/waterfront.ts)
 *   &wait=s            seconds to let showcase objects stream in (default 8)
 *   e.g. ?lab=block&pose=592,1.7,89.5,1.57   (under the High Line)
 */
const far = new Waterfront();
let eye = new THREE.Vector3();
let camera: THREE.Camera | null = null;
const scene: LabScene = {
  name: 'block',
  description: 'one real city block at its world position, camera at a world pose (&pose=x,y,z,yaw &cx=&cz= &ring=0|1|2)',
  cam: [0, 1.7, 0],
  look: [0, 1.7, -10],
  env: 'nyc',
  ground: false,
  async build({ group, params, camera: cm }) {
    camera = cm;
    const pose = (params.get('pose') ?? '').split(',').map(Number);
    const [px, py, pz, yaw, pitch] = [pose[0] || 0, pose[1] || 1.7, pose[2] || 0, pose[3] || 0, pose[4] || 0];
    eye = new THREE.Vector3(px, py, pz);
    const cx = params.has('cx') ? Number(params.get('cx')) : Math.round(px / AX);
    const cz = params.has('cz') ? Number(params.get('cz')) : Math.round(pz / SZ);
    const ring = Number(params.get('ring') ?? 0);
    const lv = Object.create(NycLevel.prototype) as { seed: number; chunks: Map<string, unknown>; steam: unknown[]; group: THREE.Group; block(cx: number, cz: number): { group: THREE.Group; hulls?: Hull[] } };
    lv.seed = Number(params.get('seed') ?? 20261105);
    lv.chunks = new Map();
    lv.steam = [];
    lv.group = new THREE.Group();
    group.add(lv.group);
    const hlod = new CityHlod();
    hlod.attach(group);
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const own = dx === 0 && dz === 0;
        if (!own && ring === 0) continue;
        const ch = lv.block(cx + dx, cz + dz);
        ch.group.position.set((cx + dx) * AX, 0, (cz + dz) * SZ);
        if (own || ring >= 2) lv.group.add(ch.group);
        else hlod.set(hlod.add(cx + dx, cz + dz, heightGrid(ch.group), ch.hulls, true), 'draw');
      }
    if (params.get('water') !== '0') {
      group.add(far.group);
      far.update(0, eye);
    }
    group.userData.cam = eye.clone();
    group.userData.look = eye.clone().add(new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(10));
    const until = performance.now() + Number(params.get('wait') ?? 8) * 1000;
    while (performance.now() < until) {
      await new Promise((r) => setTimeout(r, 300));
      updateShowcases(eye);
    }
  },
  update(_dt, time) {
    updateShowcases(eye);
    tickWater(time);
    far.update(time, camera?.position ?? eye);
    if (camera) updateDetail(camera.position, 30);
  },
};
export default scene;
