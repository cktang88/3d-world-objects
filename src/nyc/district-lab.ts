import * as THREE from 'three';
import type { LabScene } from '../lab';
import { NycLevel } from '../nyc';
import { updateDetail } from '../detail';
import { showcaseStats, shownEntries, SHOWCASE, updateShowcases } from './district-showcase';
import { tickWater } from './district-tex';
import { AX, SZ } from './common';

/**
 * Lab scenes for the districts: only the district's own blocks (no traffic, no crowd, not the
 * whole streamed level: the shared machine renders in software), built by nyc.ts's real block
 * builder, then wait until the showcase objects near the point have streamed in.
 *   ?lab=district-park&cx=0&cz=-4&r=1 (blocks around) &wait=40 (s for showcase loads) &radius=
 */
export function districtLab(name: string, description: string, cx: number, cz: number, cam: [number, number, number], look: [number, number, number], span: [number, number] = [1, 0]): LabScene {
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
      const rx = Number(params.get('rx') ?? span[0]), rz = Number(params.get('rz') ?? span[1]);
      player.set(Number(params.get('px') ?? ccx * AX), 0, Number(params.get('pz') ?? ccz * SZ));
      // camera relative to the block's centre (&rcam=x,y,z&rlook=x,y,z)
      const rel = (k: string, d: [number, number, number]) => new THREE.Vector3(...((params.get(k)?.split(',').map(Number) as [number, number, number]) ?? d)).add(new THREE.Vector3(ccx * AX, 0, ccz * SZ));
      group.userData.cam = rel('rcam', cam);
      group.userData.look = rel('rlook', look);
      if (params.get('radius')) SHOWCASE.radius = Number(params.get('radius'));
      if (params.get('cap')) SHOWCASE.cap = Number(params.get('cap')); // load only slots this close to the player (px, pz)
      // a bare NycLevel: just the chunk builder, no traffic or pedestrians
      const lv = Object.create(NycLevel.prototype) as { seed: number; chunks: Map<string, unknown>; group: THREE.Group; steam: unknown[]; block(x: number, z: number): { group: THREE.Group } };
      lv.seed = Number(params.get('seed') ?? 20261105);
      lv.chunks = new Map();
      lv.group = new THREE.Group();
      lv.steam = [];
      group.add(lv.group);
      for (let dz = -rz; dz <= rz; dz++)
        for (let dx = -rx; dx <= rx; dx++) {
          // block-local build (as tests/world.ts does), placed at its grid position
          const ch = lv.block(ccx + dx, ccz + dz);
          ch.group.position.set((ccx + dx) * AX, 0, (ccz + dz) * SZ);
          lv.group.add(ch.group);
        }
      const until = performance.now() + Number(params.get('wait') ?? 40) * 1000;
      let calm = 0;
      while (performance.now() < until) {
        await new Promise((r) => setTimeout(r, 300));
        updateShowcases(player);
        const s = showcaseStats();
        calm = s.loading === 0 ? calm + 1 : 0;
        if (calm > 6) break;
      }
      (window as unknown as { __lab: unknown }).__lab = { stats: showcaseStats(), shown: shownEntries() };
    },
    update(_dt, time) {
      updateShowcases(player);
      tickWater(time);
      if (camera) updateDetail(camera.position, 30);
    },
  };
}
