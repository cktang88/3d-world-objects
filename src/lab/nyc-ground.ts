import * as THREE from 'three';
import type { LabScene } from '../lab';
import { AX, SZ, BX, BZ, LX, LZ, CURB, bake, B } from '../nyc/common';
import { groundBase, groundDetails, groundReady } from '../nyc/ground';
import * as P from '../nyc/streetprops';
import { mat } from '../build';
import { Rng } from '../rng';

/**
 * ?lab=nyc-ground — NYC ground surfaces at street level: the NE corner of block (0,0) with its
 * crosswalks, ramps, curb, fixtures and the neighbouring blocks' halves of the roadway.
 *   &village=1   Belgian-block streets
 *   &props=0     no street furniture
 * Views: corner  cam=57,1.6,21&look=49,0,28   avenue sidewalk  cam=50.5,1.6,2&look=50,0,14
 *        crosswalk cam=60,1.6,18&look=56,0,26  from above        cam=60,30,40&look=52,0,24
 */
const scene: LabScene = {
  name: 'nyc-ground',
  description: 'NYC sidewalks, curbs, ramps, roadway and markings (&village=1 Belgian block)',
  cam: [57, 1.6, 21],
  look: [49, 0, 28],
  env: 'nyc',
  ground: false,
  async build({ group, params }) {
    const village = params.get('village') === '1';
    for (const [cx, cz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const g = new THREE.Group();
      g.position.set(cx * AX, 0, cz * SZ);
      const stat = new THREE.Group();
      groundBase({ group: g, stat, cx, cz, village, cobble: village });
      if (cx === 0 && cz === 0) {
        groundDetails({ group: g, stat, cx, cz, village, doors: [], showcase: true });
        if (params.get('props') !== '0') {
          const r = new Rng(3);
          P.signalPole(stat, BX - 0.9, BZ - 0.9, 1, 1);
          P.hydrant(stat, BX - 0.7, 12);
          P.subway(stat, g, BX - 2.2, BZ - 9, 3, r);
          P.litterBasket(stat, BX - 0.55, BZ - 5.2);
        }
        // building masses along the lot lines, for context
        B(stat, mat('#8a6d5a', { rough: 0.9 }), LX * 2, 14, 0.6, 0, CURB, LZ - 0.3);
        B(stat, mat('#9a8a78', { rough: 0.9 }), 0.6, 14, LZ * 2, LX - 0.3, CURB, 0);
      } else {
        B(stat, mat('#7d7468', { rough: 0.9 }), LX * 2 - 1, 12, LZ * 2 - 1, 0, CURB, 0);
      }
      g.add(bake(stat));
      group.add(g);
    }
    await groundReady();
  },
};
export default scene;
