import * as THREE from 'three';
import type { LabScene } from '../lab';
import { NycLevel } from '../nyc';
import { AX } from '../nyc/common';
import { heightGrid } from '../nyc/occlusion';
import { CityHlod } from '../nyc/hlod';

/**
 * ?lab=hlod&cx=0&cz=0 — one real city block (left) next to its HLOD proxy (right), for judging the
 * far-chunk stand-in. &night=1 lights the proxy windows (via lighting's night factor).
 */
const scene: LabScene = {
  name: 'hlod',
  description: 'a real block next to its HLOD proxy (&cx=&cz=)',
  cam: [60, 60, 150],
  look: [60, 10, 0],
  env: 'nyc',
  ground: false,
  build({ group, params }) {
    const cx = Number(params.get('cx') ?? 0), cz = Number(params.get('cz') ?? 0);
    // a bare level: just build the one block (no 3x3, traffic or people)
    const lv = Object.create(NycLevel.prototype) as { seed: number; steam: unknown[]; group: THREE.Group; block(cx: number, cz: number): unknown };
    lv.seed = Number(params.get('seed') ?? 20261105);
    lv.steam = [];
    lv.group = new THREE.Group();
    const ch = lv.block(cx, cz) as { group: THREE.Group; hulls?: import('../nyc/buildings').Hull[] };
    group.add(ch.group);
    const grid = heightGrid(ch.group);
    const h = new CityHlod();
    h.attach(group);
    const id = h.add(1, 0, grid, ch.hulls, true); // placed one chunk to the east
    h.set(id, 'draw');
    void AX;
  },
};
export default scene;
