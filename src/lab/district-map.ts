import * as THREE from 'three';
import type { LabScene } from '../lab';
import { districtAt, MAP_BOUNDS } from '../nyc/districts';

/** ?lab=district-map — the district map seen from above, one coloured tile per block (+x west, +z south) */
const COL: Record<string, string> = {
  midtown: '#9aa3ad', timesq: '#e8463c', music: '#7a4fb0', garment: '#c98b3a', bowery: '#d7b23a', canal: '#3a8fd7', market: '#5fae4a', brownstone: '#8a5a3c',
  industrial: '#5c5c5c', construction: '#e0a21c', museum: '#e8e0c8', autorow: '#2fc4c4', park: '#2e7d32', airport: '#cfcfcf', pier: '#4a7fa0', river: '#1f3f5a',
};
const scene: LabScene = {
  name: 'district-map',
  description: 'the NYC district map from above (tiles per block, the tall tile is the spawn block)',
  cam: [0, 70, 0.1],
  look: [0, 0, 0],
  env: 'studio',
  ground: false,
  build({ group }) {
    const { x0, z0, w, h } = MAP_BOUNDS;
    for (let cz = z0 - 4; cz < z0 + h + 4; cz++)
      for (let cx = x0 - 1; cx < x0 + w + 1; cx++) {
        const d = districtAt(cx, cz);
        const m = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.2, 1.8), new THREE.MeshBasicMaterial({ color: COL[d.kind] ?? '#ff00ff' }));
        m.position.set((cx - 1.5) * 3.8, 0, (cz + 2) * 2);
        if (cx === 0 && cz === 0) m.scale.y = 8;
        group.add(m);
      }
  },
};
export default scene;
