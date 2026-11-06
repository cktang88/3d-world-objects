import * as THREE from 'three';
import type { LabScene } from '../lab';
import { NycLevel } from '../nyc';

/**
 * ?lab=light-street — a few blocks of the real NYC level (traffic, people, lamps) for tuning
 * global lighting. Add &tod=day|golden|dusk|night; press T to cycle.
 */
let level: NycLevel | null = null;
const focus = new THREE.Vector3(50.5, 0, 22);
const scene: LabScene = {
  name: 'light-street',
  description: 'NYC avenue for lighting / time of day',
  cam: [50.5, 1.7, 24],
  look: [53, 7, -30],
  env: 'nyc',
  ground: false,
  build({ group, params }) {
    level = new NycLevel({ kind: 'nyc', seed: Number(params.get('seed') ?? 20261105), name: 'lab' });
    group.add(level.group);
    // build the outer ring of blocks before the shot
    for (let i = 0; i < 20; i++) level.update(0.016, focus, i * 0.016);
  },
  update(dt, time) {
    level?.update(dt, focus, time);
  },
};
export default scene;
