import * as THREE from 'three';
import type { LabScene } from '../lab';
import { NycLevel, setNight } from '../nyc';

/**
 * ?lab=nyc-block&seed=20261105&night=0..1&px=0&pz=0 — the streamed NYC level (blocks around the
 * player position px,pz), orbited instead of walked.
 */
let level: NycLevel | null = null;
const player = new THREE.Vector3();
const scene: LabScene = {
  name: 'nyc-block',
  description: 'the streamed NYC level around a point (seed=, night=, px=, pz=)',
  cam: [40, 25, 60],
  look: [0, 8, 0],
  env: 'nyc',
  ground: false,
  build({ group, params }) {
    level = new NycLevel({ kind: 'nyc', seed: Number(params.get('seed') ?? 20261105), name: 'Manhattan' });
    group.add(level.group);
    (window as unknown as { __lab: unknown }).__lab = { level };
    player.set(Number(params.get('px') ?? 0), 0, Number(params.get('pz') ?? 0));
    // stream in everything around the point before the screenshot
    for (let i = 0; i < 30; i++) level.update(0.016, player, 0);
    setNight(Number(params.get('night') ?? 0));
  },
  update(dt, time) {
    level?.update(dt, player, time);
  },
};
export default scene;
