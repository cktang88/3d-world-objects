import * as THREE from 'three';
import type { LabScene } from '../lab';
import { NycLevel } from '../nyc';
import { updateDetail } from '../detail';
import { showcaseStats, shownEntries, SHOWCASE } from './district-showcase';
import { AX, SZ } from './common';

/**
 * Lab scenes for the districts: the streamed NYC level around one district, orbited, waiting
 * until the showcase objects near the point have streamed in.
 *   ?lab=district-park&cx=0&cz=-4&px=..&pz=..&people=0&wait=40
 */
export function districtLab(name: string, description: string, cx: number, cz: number, cam: [number, number, number], look: [number, number, number]): LabScene {
  let level: NycLevel | null = null;
  const player = new THREE.Vector3();
  let camera: THREE.Camera | null = null;
  return {
    name,
    description,
    cam,
    look,
    env: 'nyc',
    ground: false,
    async build({ group, params, camera: cm }) {
      camera = cm;
      const ccx = Number(params.get('cx') ?? cx), ccz = Number(params.get('cz') ?? cz);
      player.set(Number(params.get('px') ?? ccx * AX), 0, Number(params.get('pz') ?? ccz * SZ));
      // the camera and target are relative to the district's chunk
      group.userData.cam = new THREE.Vector3(...cam).add(new THREE.Vector3(ccx * AX, 0, ccz * SZ));
      group.userData.look = new THREE.Vector3(...look).add(new THREE.Vector3(ccx * AX, 0, ccz * SZ));
      if (params.get('radius')) SHOWCASE.radius = Number(params.get('radius'));
      level = new NycLevel({ kind: 'nyc', seed: Number(params.get('seed') ?? 20261105), name: 'Manhattan' });
      group.add(level.group);
      for (let i = 0; i < 40; i++) level.update(0.016, player, 0);
      // stream the showcase objects in before the screenshot
      const until = performance.now() + Number(params.get('wait') ?? 45) * 1000;
      let calm = 0;
      while (performance.now() < until) {
        await new Promise((r) => setTimeout(r, 250));
        level.update(0.016, player, 0);
        const s = showcaseStats();
        calm = s.loading === 0 ? calm + 1 : 0;
        if (calm > 8) break;
      }
      (window as unknown as { __lab: unknown }).__lab = { level, stats: showcaseStats(), shown: shownEntries() };
      console.log('showcase', JSON.stringify(showcaseStats()));
    },
    update(dt, time) {
      level?.update(dt, player, time);
      if (camera) updateDetail(camera.position, 30);
    },
  };
}
