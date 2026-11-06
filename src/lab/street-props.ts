import * as THREE from 'three';
import type { LabScene } from '../lab';
import * as P from '../nyc/streetprops';
import { bake, CURB } from '../nyc/common';
import { Rng } from '../rng';

/**
 * ?lab=street-props — NYC street furniture on a strip of kerb.
 *   &set=lights|signals|small|big (default: small)
 */
const scene: LabScene = {
  name: 'street-props',
  description: 'NYC street furniture: &set=small|lights|signals|big',
  cam: [0, 1.7, 7],
  look: [0, 0.8, 0],
  env: 'nyc',
  build({ group, params }) {
    const stat = new THREE.Group();
    const r = new Rng(5);
    // a raised sidewalk slab so props sit at kerb height as in the city
    const slab = new THREE.Mesh(new THREE.BoxGeometry(30, CURB, 8), new THREE.MeshStandardMaterial({ color: '#b5b0a6', roughness: 0.95 }));
    slab.position.set(0, CURB / 2, -2);
    slab.receiveShadow = true;
    group.add(slab);
    const set = params.get('set') ?? 'small';
    if (set === 'small') {
      P.hydrant(stat, -3, 0, new Rng(1), 0.5);
      P.hydrant(stat, -2.2, 0, new Rng(3), 0.2);
      P.litterBasket(stat, -1, 0);
      P.mailbox(stat, 0.3, 0);
      P.muniMeter(stat, 1.4, 0);
      P.newsBoxes(stat, 3, 0, 'x', r);
      P.trashBags(stat, 5, -0.5, r);
      P.manhole(stat, -1, 2.2, 0);
      P.manhole(stat, 1, 2.2, 1);
    } else if (set === 'lights') {
      P.lampPost(stat, group, -3, 1, 'x', 1, 'cobra');
      P.lampPost(stat, group, 3, 1, 'x', 1, 'crook');
    } else if (set === 'signals') {
      P.signalPole(stat, 0, 0, 1, 1);
      stat.add(P.nameSign('W 34 St', 0, CURB + 6.3, 0, 0));
      stat.add(P.nameSign('Broadway', 0, CURB + 6.58, 0, Math.PI / 2));
    } else {
      P.subway(stat, group, -8, -2, 3, r);
      P.busShelter(stat, -1, -1, 0);
      P.newsstand(stat, 5, -2, 0);
      P.steamStack(stat, 10, 1.5);
      P.bikeDock(stat, -12, 1, 0, 5, r);
      P.sidewalkShed(stat, 4, -5.5, 0, 9);
    }
    group.add(bake(stat));
  },
};
export default scene;
