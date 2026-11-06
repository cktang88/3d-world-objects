import * as THREE from 'three';
import type { LabScene } from '../lab';
import { InteriorLevel } from '../interior';

/**
 * ?lab=interior-room&style=apartment&seed=N&floor=0&room=K&corner=C
 * One whole InteriorLevel. The camera stands in room K (index by size, default the largest, or a
 * type: living, kitchen, bedroom, bathroom, office, ...) at eye height in corner C (0-3), looking
 * across it. &view=plan looks straight down with the ceiling hidden.
 */
let level: InteriorLevel | null = null;
const scene: LabScene = {
  name: 'interior-room',
  description: 'one generated building interior: &style=apartment|house|office|... &seed= &room=<index|type> &corner=0-3 &view=plan',
  ground: false,
  env: 'museum',
  build({ group, params }) {
    level?.dispose();
    const style = params.get('style') ?? 'apartment';
    const seed = Number(params.get('seed') ?? 1);
    const floor = Number(params.get('floor') ?? 0);
    level = new InteriorLevel({ kind: 'interior', seed, name: 'Lab', style, floor, floors: Number(params.get('floors') ?? 3), biome: 'town' });
    group.add(level.group);
    group.userData.env = level.env;
    const sorted = [...level.rooms].sort((a, b) => (b.x1 - b.x0) * (b.z1 - b.z0) - (a.x1 - a.x0) * (a.z1 - a.z0));
    const want = params.get('room') ?? '0';
    const room = /^\d+$/.test(want) ? sorted[Number(want) % sorted.length] : sorted.find((r) => r.type === want) ?? sorted[0];
    const corner = Number(params.get('corner') ?? 0) % 4;
    const cx = (room.x0 + room.x1) / 2, cz = (room.z0 + room.z1) / 2;
    const sx = corner & 1 ? 1 : -1, sz = corner & 2 ? 1 : -1;
    if (params.get('view') === 'plan') {
      group.traverse((o) => {
        if (o.userData.ceiling) o.visible = false;
      });
      group.userData.cam = new THREE.Vector3(0.01, 34, 0.01);
      group.userData.look = new THREE.Vector3(0, 0, 0);
    } else {
      group.userData.cam = new THREE.Vector3(cx + sx * ((room.x1 - room.x0) / 2 - 0.4), 1.6, cz + sz * ((room.z1 - room.z0) / 2 - 0.4));
      group.userData.look = new THREE.Vector3(cx - sx * 0.8, 1.05, cz - sz * 0.8);
    }
    (window as unknown as { __interior: unknown }).__interior = { level, room, rooms: sorted.map((r) => `${r.type} ${(r.x1 - r.x0).toFixed(1)}x${(r.z1 - r.z0).toFixed(1)}`) };
  },
  update(dt, time) {
    level?.update(dt, new THREE.Vector3(), time);
  },
};
export default scene;
