import * as THREE from 'three';
import type { LabScene } from '../lab';
import type { LevelDesc } from '../level';
import { loadMuseum, museum } from '../museumData';
import { GalleryLevel } from '../museum/gallery';
import { AtriumLevel } from '../museum/atrium';
import { doorOf, entryOf, placementMatrix } from '../seamless';

/**
 * ?lab=museum-doors&theme=<n>&exit=<k>   a gallery and the room behind exit k, placed as seamless.ts
 * places a preview (entry doorway on the door) and shown through the opening. &atrium=1 starts in
 * the atrium (exit k = wing door k). Camera: 5 m inside the doorway, looking through it.
 */
const levels: (GalleryLevel | AtriumLevel)[] = [];
const scene: LabScene = {
  name: 'museum-doors',
  description: 'a museum room with the next room shown through a doorway (&theme=, &exit=, &atrium=1)',
  env: 'museum',
  ground: false,
  async build({ group, params, camera }) {
    await loadMuseum();
    const a = params.has('atrium') ? new AtriumLevel() : new GalleryLevel({ kind: 'gallery', theme: Number(params.get('theme') ?? museum().wings[0].theme), page: 0 });
    levels.push(a);
    (window as unknown as { __doors: unknown }).__doors = a;
    group.add(a.group);
    await a.built;
    const exits = a.portals().filter((p) => p.auto && typeof p.target === 'object' && p.door?.see);
    const exit = exits[Number(params.get('exit') ?? 0) % exits.length];
    const door = doorOf(exit)!;
    const b = new GalleryLevel(exit.target as Extract<LevelDesc, { kind: 'gallery' }>);
    levels.push(b);
    await b.built;
    const entry = entryOf(b)!;
    placementMatrix(door, entry).decompose(b.group.position, b.group.quaternion, b.group.scale);
    for (const o of entry.hide ?? []) o.visible = false;
    exit.onPreview?.(true);
    (window as unknown as { __door: unknown }).__door = { x: +door.pos.x.toFixed(2), z: +door.pos.z.toFixed(2), yaw: +door.yaw.toFixed(3) };
    group.add(b.group);
    const f = new THREE.Vector3(-Math.sin(door.yaw), 0, -Math.cos(door.yaw));
    if (!params.has('cam')) {
      camera.position.copy(door.pos).addScaledVector(f, -6.5).setY(1.6);
      camera.lookAt(door.pos.clone().addScaledVector(f, 6).setY(1.5));
    }
    await Promise.race([Promise.all(levels.map((l) => l.ready)), new Promise((r) => setTimeout(r, Number(params.get('maxwait') ?? 30000)))]);
  },
  update(dt, time) {
    for (const l of levels) l.update(dt, new THREE.Vector3(0, 1.6, -2), time);
  },
};
export default scene;
