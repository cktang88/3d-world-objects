/** Museum doorways: walking up to any onward doorway (4 m, facing it) builds the next room and shows it through the opening before you reach it. */
import * as THREE from 'three';
import { test, expect, none } from './qa';
import { settle } from './env';
import { loadMuseum } from '../src/museumData';
import { GalleryLevel, AtriumLevel } from '../src/museum';
import { Seamless, descKey, facing } from '../src/seamless';
import type { Level, LevelDesc, Portal } from '../src/level';

function makeSeam(camera: THREE.PerspectiveCamera, scene: THREE.Scene) {
  return new Seamless({
    scene, camera, capacity: 4,
    renderer: { toneMappingExposure: 1, compileAsync: () => Promise.resolve() } as unknown as THREE.WebGLRenderer,
    build: (d) => (d.kind === 'atrium' ? new AtriumLevel() : new GalleryLevel(d as Extract<LevelDesc, { kind: 'gallery' }>)),
  });
}

/** stand 4 m before each see-through doorway of `lv`, facing it; the room behind must be built, in the scene and visible */
async function approachAll(seam: Seamless, lv: Level, camera: THREE.PerspectiveCamera, scene: THREE.Scene, where: string, bad: string[]) {
  const doors = lv.portals().filter((p): p is Portal & { door: NonNullable<Portal['door']> } => !!p.door?.see && typeof p.target === 'object');
  expect(doors.length > 0, `${where}: no see-through doorways`);
  for (const p of doors) {
    const door = p.door;
    const player = door.pos.clone().addScaledVector(facing(door.yaw), -4 - 2.6); // 4 m before the passage mouth
    camera.position.set(player.x, 1.6, player.z);
    camera.lookAt(door.pos.x, 1.6, door.pos.z);
    camera.updateMatrixWorld(true);
    const key = descKey(p.target as LevelDesc);
    const ok = () => { const s = seam.slots.get(key); return !!s?.shown && s.level.group.parent === scene && s.level.group.visible; };
    for (let i = 0; i < 500 && !ok(); i++) {
      seam.update(1 / 60, lv, player);
      await settle(5);
    }
    if (!ok()) {
      const s = seam.slots.get(key);
      bad.push(`${where} · ${p.label}: ${s ? `built ${s.ready}, waiting ${s.waiting}, shown ${s.shown}, visible ${s.level.group.visible}` : 'never prebuilt'}`);
    }
  }
}

test('atrium: every doorway shows its wing from 4 m', async () => {
  await loadMuseum();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 500), scene = new THREE.Scene();
  const seam = makeSeam(camera, scene);
  const here = seam.take({ kind: 'atrium' });
  seam.setActive(here);
  const bad: string[] = [];
  await approachAll(seam, here.level, camera, scene, 'atrium', bad);
  seam.clear();
  none(bad, 'doorways still solid at 4 m');
});

test('two galleries (an Objaverse room, a Smithsonian room): every onward doorway shows the next room from 4 m', async () => {
  await loadMuseum();
  const bad: string[] = [];
  for (const theme of [811, 2453]) {
    const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 500), scene = new THREE.Scene();
    const seam = makeSeam(camera, scene);
    const here = seam.take({ kind: 'gallery', theme, page: 0 });
    seam.setActive(here);
    const g = here.level as GalleryLevel;
    await Promise.race([g.built, settle(8000)]);
    await approachAll(seam, g, camera, scene, `gallery ${theme}`, bad);
    seam.clear();
  }
  none(bad, 'doorways still solid at 4 m');
});

test('a previewed room casts no shadows and is hidden when its doorway is out of view', async () => {
  await loadMuseum();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 500), scene = new THREE.Scene();
  const seam = makeSeam(camera, scene);
  const here = seam.take({ kind: 'atrium' });
  seam.setActive(here);
  const p = here.level.portals().find((q) => q.door?.see && typeof q.target === 'object')!;
  const door = p.door!;
  const player = door.pos.clone().addScaledVector(facing(door.yaw), -6.6);
  camera.position.set(player.x, 1.6, player.z);
  camera.lookAt(door.pos.x, 1.6, door.pos.z);
  camera.updateMatrixWorld(true);
  const s = () => seam.slots.get(descKey(p.target as LevelDesc));
  for (let i = 0; i < 500 && !s()?.shown; i++) { seam.update(1 / 60, here.level, player); await settle(5); }
  expect(s()?.shown, 'not shown');
  let casters = 0;
  s()!.level.group.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.castShadow) casters++; });
  expect(casters === 0, `${casters} shadow casters in a previewed room`);
  // turn round: the doorway leaves the view, the room behind it is not drawn
  camera.lookAt(player.x * 2 - door.pos.x, 1.6, player.z * 2 - door.pos.z);
  camera.updateMatrixWorld(true);
  for (let i = 0; i < 3; i++) seam.update(1 / 60, here.level, player);
  expect(!s()!.shown || !s()!.level.group.visible, 'a previewed room behind you is still drawn');
  seam.clear();
});
