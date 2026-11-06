import * as THREE from 'three';
import type { LabScene } from '../lab';
import { NycLevel } from '../nyc';

/**
 * ?lab=light-street — a few blocks of the real NYC level (traffic, people, lamps) for tuning
 * global lighting. Add &tod=day|golden|dusk|night; press T to cycle.
 */
let level: NycLevel | null = null;
let live = false;
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
    // only the initial 3x3 blocks (no streaming ring) to keep memory down; &live=1 animates and streams
    live = params.has('live');
  },
  update(dt, time) {
    if (live) level?.update(dt, focus, time);
  },
};
export default scene;
