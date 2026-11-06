import * as THREE from 'three';
import type { LabScene } from '../lab';
import { LIB, fillHolder } from '../rooms/lib';
import { signTex } from '../textures';

/**
 * ?lab=interior-lib — every Poly Haven model the interiors use, at real size, in a grid seen from
 * the front. A red arrow on the floor points to +z: the model's front should face it.
 * &only=a,b limits the set.
 */
const scene: LabScene = {
  name: 'interior-lib',
  description: 'Poly Haven interior models with a +z arrow (front check)',
  cam: [0, 6, 14],
  look: [0, 0.6, 0],
  env: 'studio',
  async build({ group, params }) {
    const only = params.get('only')?.split(',');
    const ids = Object.keys(LIB).filter((id) => !only || only.includes(id));
    const cols = Number(params.get('cols') ?? 8);
    const gap = 2.6;
    const arrow = new THREE.MeshBasicMaterial({ color: '#e0302a' });
    const loads: Promise<unknown>[] = [];
    ids.forEach((id, i) => {
      const x = ((i % cols) - (cols - 1) / 2) * gap;
      const z = (Math.floor(i / cols) - Math.floor((ids.length - 1) / cols) / 2) * gap * 1.2;
      const h = new THREE.Group();
      h.position.set(x, 0, z);
      group.add(h);
      loads.push(fillHolder(h, id));
      const a = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.35, 3), arrow);
      a.rotation.x = Math.PI / 2;
      a.position.set(x, 0.02, z + LIB[id][2] / 2 + 0.3);
      group.add(a);
      const label = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.3), new THREE.MeshBasicMaterial({ map: signTex(`${i} ${id}`, '#222', '#fff') }));
      label.rotation.x = -Math.PI / 2;
      label.position.set(x, 0.02, z + LIB[id][2] / 2 + 0.75);
      group.add(label);
    });
    await Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, 60000))]);
  },
};
export default scene;
