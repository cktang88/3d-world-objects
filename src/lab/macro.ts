import * as THREE from 'three';
import type { LabScene } from '../lab';
import { allModels } from '../assets';
import { MacroLevel, shrinkInto } from '../macro';
import type { LevelDesc } from '../level';

/**
 * ?lab=macro&role=plant|container|storage|electronics|food|tool&i=0 — the world you shrink into from an
 * object of that role (src/macro.ts), seen from where you arrive.
 */
const scene: LabScene = {
  name: 'macro',
  description: 'the world inside a small object you shrink into (garden, vessel, circuit, food, surface)',
  ground: false,
  build({ group, params }) {
    const role = params.get('role') ?? 'plant';
    const list = [...allModels()].filter((m) => m.role === role);
    const e = list[Number(params.get('i') ?? 0) % Math.max(1, list.length)];
    if (!e) return;
    const p = shrinkInto(e, 0.3, Number(params.get('seed') ?? 7), 'town');
    if ((p.target as LevelDesc).kind !== 'macro') return;
    const lv = new MacroLevel(p.target as Extract<LevelDesc, { kind: 'macro' }>);
    group.add(lv.group);
    const s = lv.spawn.pos;
    // the first view the player gets: from the spawn, towards the level's focus
    const f = lv.focus.lengthSq() ? lv.focus : new THREE.Vector3(0, 4, 0);
    const back = new THREE.Vector3(s.x - f.x, 0, s.z - f.z).normalize().multiplyScalar(params.get('before') ? 1.5 : 0.01);
    group.userData.cam = new THREE.Vector3(s.x + back.x, 1.65, s.z + back.z);
    group.userData.look = f.clone();
    group.userData.env = lv.env;
    group.userData.place = 'studio';
    console.info('[lab macro]', e.title, p.label, '—', p.sub);
  },
};
export default scene;
