import * as THREE from 'three';
import type { LabScene } from '../lab';
import { FloorLevel, SPECS, type BType } from '../rooms/vertical';
import { lobbyStyleFor } from '../rooms/lobbies';

/**
 * ?lab=vertical — a building's floors with the stair between them (src/rooms/vertical.ts): the
 * floor you stand on, and the floors above and below placed at ±H the way src/vertical.ts shows
 * them through the stairwell.
 *   &type=walkup|prewar|office|loft  &floor=n  &floors=n  &bseed=n
 *   &view=stair|hall|lobby|up|down|roof|lift  (camera presets)  &open=1 opens the lift doors
 */
let live: FloorLevel | null = null;
let cam0: THREE.Camera | null = null;
const scene: LabScene = {
  // the lobby's staff and sculpture come alive as in the game (FloorLevel.update with the viewer's position)
  update(dt: number) {
    if (live && cam0) live.update(dt, cam0.position);
  },
  name: 'vertical',
  description: 'stairs between floors, halls, lobbies, lift fronts and the roof of a building (vertical circulation)',
  ground: false,
  env: 'museum',
  build({ group, params, camera }) {
    cam0 = camera;
    // &style=deco|midcentury|postmodern|atrium|coop|loft: a building with that lobby (view=lobby)
    const want = params.get('style');
    const type = (want ? (want === 'coop' ? 'prewar' : want === 'loft' ? 'loft' : 'office') : params.get('type') ?? 'walkup') as BType;
    const floors = Number(params.get('floors') ?? 6);
    const view = params.get('view') ?? 'stair';
    const floor = Number(params.get('floor') ?? (view === 'lobby' ? 0 : view === 'roof' ? floors : 2));
    let seed = Number(params.get('bseed') ?? 4242);
    if (want) for (let i = 0; i < 500 && lobbyStyleFor(type, seed).id !== want; i++) seed++;
    const mk = (f: number) => new FloorLevel({ kind: 'floor', seed, name: '214 Orchard St', type: SPECS[type] ? type : 'walkup', floor: f, floors });
    const lv = mk(floor);
    live = lv;
    group.add(lv.group);
    const H = lv.d.H;
    // neighbours as src/vertical.ts shows them: lights out, their stair hidden, at ±H
    for (const dir of [1, -1]) {
      const f = floor + dir;
      if (f < 0 || f > floors || params.get('neighbours') === '0') continue;
      const n = mk(f);
      const lights: THREE.Object3D[] = [];
      n.group.traverse((o) => (o as THREE.Light).isLight && lights.push(o));
      lights.forEach((l) => l.removeFromParent());
      n.well.visible = false;
      n.group.position.y = dir * H;
      group.add(n.group);
      lv.setStub(dir, true);
    }
    if (params.get('open') === '1') for (const l of lv.lifts) {
      l.left.position.x -= 0.47;
      l.right.position.x += 0.47;
    }
    const d = lv.d;
    const cams: Record<string, [number[], number[]]> = {
      stair: [[d.bx1 - 0.3, 1.65, d.Ld + 2.2], [d.ax1 - 0.3, 1.2, -d.Lf * 0.6]],
      hall: [[0, 1.65, d.Ld + 0.6], [0, 1.4, d.zH1]],
      lobby: [[0.2, 1.75, d.zS - 0.35], [-d.lw / 5, 1.9, d.zH1 + (d.zS - d.zH1) * 0.3]],
      up: [[0.05, 1.3, d.Ld * 0.5], [0, H * 1.6, -d.Lf * 0.5]],
      down: [[d.bx0 + 0.2, H * 0.5 + 1.6, -d.Lf - 0.3], [d.ax1, -H * 0.4, -0.4]],
      roof: [[d.SW / 2 + 1.5, 1.7, d.Ld + 5], [0, 1.2, d.Ld]],
      lift: [[0, 1.65, d.Ld + (SPECS[type]?.lifts[0]?.at ?? 1.3)], [d.hw / 2, 1.3, d.Ld + (SPECS[type]?.lifts[0]?.at ?? 1.3)]],
      out: [[14, H * 0.5, 9], [0, 0, 0]],
    };
    const [c, l] = cams[view] ?? cams.stair;
    group.userData.cam = new THREE.Vector3(...c);
    group.userData.look = new THREE.Vector3(...l);
    if (view === 'lift') group.userData.cam.x = -d.hw / 2 + 0.4;
    group.userData.env = lv.env;
    group.userData.place = lv.roof ? 'outdoor' : 'interior';
    (window as unknown as { __vlab: unknown }).__vlab = { lv, d };
  },
};
export default scene;
