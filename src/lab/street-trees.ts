import * as THREE from 'three';
import type { LabScene } from '../lab';
import { treeMesh, SPECIES, type Species } from '../nyc/streettrees';
import { tree } from '../nyc/streetprops';
import { bake } from '../nyc/common';
import { Rng } from '../rng';

/**
 * ?lab=street-trees — the NYC street tree species side by side (&lod=lo for the far model),
 * or &row=1 for a planted sidewalk run (pits, guards, instanced trees) as in the city.
 */
const scene: LabScene = {
  name: 'street-trees',
  description: 'London plane, honey locust, pear street trees; &lod=lo, &row=1, &sp=plane&v=0',
  cam: [0, 4, 26],
  look: [0, 5.5, 0],
  env: 'nyc',
  build({ group, params }) {
    if (params.has('row')) {
      const stat = new THREE.Group();
      const r = new Rng(12);
      for (let i = 0; i < 4; i++) tree(stat, (i - 1.5) * 9, 0, r, group, 'x', params.get('sp') as Species | undefined);
      group.add(bake(stat));
      return;
    }
    const lod = params.get('lod') === 'lo' ? 'lo' : 'hi';
    const sp = params.get('sp') as Species | null;
    const list: [Species, number][] = sp ? [0, 1, 2].map((v) => [sp, v]) : SPECIES.map((s) => [s, Number(params.get('v') ?? 0)]);
    list.forEach(([s, v], i) => {
      const t = treeMesh(s, v, lod);
      t.position.x = (i - (list.length - 1) / 2) * 11;
      group.add(t);
    });
  },
};
export default scene;
