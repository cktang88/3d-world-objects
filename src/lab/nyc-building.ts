import * as THREE from 'three';
import type { LabScene } from '../lab';
import { bake, M } from '../nyc/common';
import { building, makeCtx, finishBuildings, setNight, type BType } from '../nyc/buildings';
import { Rng } from '../rng';

/**
 * ?lab=nyc-building&type=brownstone|tenement|prewar|midrise|castiron|tower&n=3&store=0|1&seed=1&night=0..1
 * A short row of buildings of one type on a sidewalk, facing +z (towards the default camera).
 */
const scene: LabScene = {
  name: 'nyc-building',
  description: 'a row of NYC buildings of one type (type=, n=, store=, seed=, night=)',
  cam: [4, 3, 16],
  look: [0, 6, 0],
  env: 'nyc',
  ground: false,
  build({ group, params }) {
    const type = (params.get('type') ?? 'tenement') as BType;
    const n = Number(params.get('n') ?? 3);
    const seed = Number(params.get('seed') ?? 1);
    const rng = new Rng(seed);
    const blockG = new THREE.Group();
    blockG.position.y = 0.15;
    group.add(blockG);
    const stat = new THREE.Group();
    const ctx = makeCtx(rng, blockG, stat, 0, 0, seed);
    const widths: Record<BType, [number, number]> = { brownstone: [5.6, 6.8], tenement: [7.4, 8.2], prewar: [14, 20], midrise: [9, 12], castiron: [9, 13], tower: [24, 30] };
    const floorsOf: Record<BType, [number, number]> = { brownstone: [3, 5], tenement: [5, 6], prewar: [10, 14], midrise: [7, 10], castiron: [5, 7], tower: [20, 30] };
    const ws = Array.from({ length: n }, () => rng.range(...widths[type]));
    let x = -ws.reduce((a, b) => a + b, 0) / 2;
    for (const w of ws) {
      const store = params.has('store') ? params.get('store') === '1' : type !== 'brownstone' && rng.chance(0.7);
      building(ctx, { minX: x, maxX: x + w, minZ: -18, maxZ: 0 }, 'S', type, rng.int(...floorsOf[type]), store, [false, false]);
      x += w;
    }
    // sidewalk and street
    const sw = new THREE.Mesh(new THREE.PlaneGeometry(120, 4.5), M.sidewalk());
    sw.rotation.x = -Math.PI / 2;
    sw.position.set(0, 0.15, 2.25);
    sw.receiveShadow = true;
    group.add(sw);
    const road = new THREE.Mesh(new THREE.PlaneGeometry(120, 30), new THREE.MeshStandardMaterial({ color: '#3d3e41', roughness: 1 }));
    road.rotation.x = -Math.PI / 2;
    road.position.set(0, 0, 19.5);
    road.receiveShadow = true;
    group.add(road);
    blockG.add(bake(stat));
    finishBuildings(ctx);
    setNight(Number(params.get('night') ?? 0));
  },
};
export default scene;
