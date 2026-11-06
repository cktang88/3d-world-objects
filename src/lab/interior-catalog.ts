import * as THREE from 'three';
import type { LabScene } from '../lab';
import { allModels, spawn, normScale } from '../assets';
import { signTex } from '../textures';

/**
 * ?lab=interior-catalog&roles=sofa,bed — every bundled model of those roles in a grid at its real
 * scale, unrotated, with its index label in front (+z side), to judge quality and which way it faces.
 */
const scene: LabScene = {
  name: 'interior-catalog',
  description: 'bundled models of &roles= in a labelled grid (front = +z)',
  cam: [0, 9, 16],
  look: [0, 0, 2],
  env: 'studio',
  async build({ group, params }) {
    const roles = (params.get('roles') ?? 'sofa,bed').split(',');
    const list = allModels().filter((m) => roles.includes(m.role));
    const cols = Number(params.get('cols') ?? 8);
    const gap = Number(params.get('gap') ?? 2.6);
    list.forEach((e, i) => {
      const s = normScale(e, e.role);
      const sp = spawn(e, s);
      const x = ((i % cols) - (cols - 1) / 2) * gap;
      const z = Math.floor(i / cols) * gap - 4;
      sp.obj.position.set(x, 0, z);
      group.add(sp.obj);
      const label = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.3), new THREE.MeshBasicMaterial({ map: signTex(`${i} ${e.role}`, '#222', '#fff') }));
      label.rotation.x = -Math.PI / 2;
      label.position.set(x, 0.02, z + 1.1);
      group.add(label);
      console.log('catalog', i, e.id, e.title);
    });
    (window as unknown as { __catalog: string[] }).__catalog = list.map((e, i) => `${i} ${e.id} ${e.title}`);
    await new Promise((r) => setTimeout(r, 3000));
  },
};
export default scene;
