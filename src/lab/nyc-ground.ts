import * as THREE from 'three';
import type { LabScene } from '../lab';
import { AX, SZ, BX, BZ, LX, LZ, CURB, bake, B } from '../nyc/common';
import { groundBase, groundDetails, groundReady, groundWeather, groundStrip, groundCurb, GM } from '../nyc/ground';
import * as P from '../nyc/streetprops';
import { mat } from '../build';
import { surface, pbr } from '../pbr';
import { Rng } from '../rng';

/**
 * ?lab=nyc-ground — NYC ground surfaces at street level: the NE corner of block (0,0) with its
 * crosswalks, ramps, curb, fixtures and the neighbouring blocks' halves of the roadway.
 *   &village=1   Belgian-block streets
 *   &props=0     no street furniture
 *   &before=1    the previous look for comparison (paver texture sidewalk, plain asphalt, box curbs, no paint)
 *   &open=1      block (0,1) is an open space (park): groundStrip() sidewalks along its open edges
 *   &weather=snow|rain (weather.ts; a sidewalk shed at x≈30 on the +z street stays dry)
 *   &wet=0..1 &puddles=0..1 &snow=0..1   weather hook (groundWeather)
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
    groundWeather.wet.value = Number(params.get('wet') ?? 0);
    groundWeather.puddles.value = Number(params.get('puddles') ?? 0);
    groundWeather.snow.value = Number(params.get('snow') ?? 0);
    for (const [cx, cz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const g = new THREE.Group();
      g.position.set(cx * AX, 0, cz * SZ);
      const stat = new THREE.Group();
      if (params.get('before') === '1') {
        const road = new THREE.Mesh(new THREE.PlaneGeometry(AX, SZ), surface('nyc_asphalt', [AX, SZ], { roughness: 1 }));
        road.rotation.x = -Math.PI / 2;
        g.add(road);
        const sw = new THREE.Mesh(new THREE.PlaneGeometry(BX * 2, BZ * 2), surface('nyc_sidewalk', [BX * 2, BZ * 2], { roughness: 1, normalScale: 1.2 }));
        sw.rotation.x = -Math.PI / 2;
        sw.position.y = CURB;
        stat.add(sw);
        const cm = mat('#8f8b84', { rough: 0.8 });
        for (const s of [-1, 1]) { B(stat, cm, BX * 2, CURB, 0.25, 0, 0, s * (BZ - 0.125), false); B(stat, cm, 0.25, CURB, BZ * 2, s * (BX - 0.125), 0, 0, false); }
      } else if (params.get('open') === '1' && cx === 0 && cz === 1) {
        // an open space: road strip + plain sidewalk runs, as district-open.ts builds them
        const road = new THREE.Mesh(new THREE.PlaneGeometry(AX, SZ), GM.road());
        road.rotation.x = -Math.PI / 2;
        g.add(road);
        groundStrip(stat, LX, BX, -BZ, SZ / 2);
        groundCurb(stat, '+x', BX, -BZ, SZ / 2);
        groundStrip(stat, -LX, LX, -BZ, -LZ);
        groundCurb(stat, '-z', -BZ, -BX, BX);
        B(stat, mat('#4f6b3a', { rough: 1 }), LX * 2, 0.05, SZ / 2 + LZ, 0, CURB, (SZ / 2 - LZ) / 2);
        g.add(bake(stat));
        group.add(g);
        continue;
      }
      if (params.get('before') !== '1') groundBase({ group: g, stat, cx, cz, village, cobble: village });
      if (cx === 0 && cz === 0) {
        if (params.get('before') !== '1') groundDetails({ group: g, stat, cx, cz, village, doors: [], showcase: true });
        if (params.get('props') !== '0') {
          const r = new Rng(3);
          P.signalPole(stat, BX - 0.9, BZ - 0.9, 1, 1);
          P.hydrant(stat, BX - 0.7, 12);
          P.subway(stat, g, BX - 2.2, BZ - 9, 3, r);
          P.litterBasket(stat, BX - 0.55, BZ - 5.2);
          P.sidewalkShed(stat, 30, LZ + 0.02, 0, 9.6); // shelter check for snow / rain (weather.ts wxExposure)
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
    if (params.get('before') === '1') await Promise.all([pbr('nyc_sidewalk')?.ready, pbr('nyc_asphalt')?.ready]);
  },
};
export default scene;
