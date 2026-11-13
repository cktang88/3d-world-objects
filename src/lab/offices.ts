import * as THREE from 'three';
import type { LabScene } from '../lab';
import { OfficeLevel, OFFICE_TYPES } from '../rooms/office';
import { signTex } from '../textures';

/**
 * ?lab=offices — contact sheet of the office suite types (src/rooms/office.ts), ceilings cut away,
 * seen from above: tech, cubicle, law, creative / eighties, dentist, gym, cowork.
 * &seed= another seed for every suite; &type=law shows one type on its own.
 */
const scene: LabScene = {
  name: 'offices',
  description: 'office suite types from above (ceilings cut away)',
  cam: [0, 44, 26],
  look: [0, 0, 2],
  env: 'studio',
  ground: false,
  build({ group, params }) {
    const seed = Number(params.get('seed') ?? 7);
    const only = params.get('type');
    const types = only ? [only] : [...OFFICE_TYPES];
    types.forEach((t, i) => {
      const lv = new OfficeLevel({ kind: 'interior', seed: seed + i, name: t, style: 'office', floor: 0, floors: 1, biome: 'town', office: t }, { cutaway: true, lights: false });
      const cx = only ? 0 : ((i % 4) - 1.5) * 24, cz = only ? 0 : (Math.floor(i / 4) - 0.5) * 20;
      lv.group.position.set(cx, 0, cz);
      group.add(lv.group);
      const m = new THREE.MeshBasicMaterial({ map: signTex(t.toUpperCase(), '#1a1c20', '#ffffff') });
      m.userData.owned = true;
      const label = new THREE.Mesh(new THREE.PlaneGeometry(6, 1.5), m);
      label.userData.owned = true;
      label.rotation.x = -Math.PI / 2;
      label.position.set(cx, 0.05, cz + lv.look.D / 2 + 1.4);
      group.add(label);
    });
  },
};
export default scene;
