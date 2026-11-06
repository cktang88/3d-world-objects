import * as THREE from 'three';
import type { LabScene } from '../lab';
import { ShopLevel } from '../shop';
import { mat } from '../build';
import { entryOf, placementMatrix } from '../seamless';

/**
 * ?lab=seamless — a street facade with a shop door and display window, and the real ShopLevel
 * prebuilt (staged, in time slices) and placed behind it the way seamless.ts does in the game:
 * the shop's entry doorway lands on the street door, its own front wall is hidden.
 * &shop=deli|bodega|pizza|hardware… &seed=  &slices=1 builds one slice per frame (watch it fill).
 */
const scene: LabScene = {
  name: 'seamless',
  description: 'a prebuilt shop seen through its street door and window (seamless doors)',
  cam: [2.2, 1.65, 6.5],
  look: [0, 1.4, -3],
  env: 'nyc',
  ground: false,
  build({ group, params }) {
    const shop = new ShopLevel(
      { kind: 'interior', seed: Number(params.get('seed') ?? 7), name: 'Lab Deli', style: 'store', floor: 0, floors: 1, biome: 'metropolis', shop: params.get('shop') ?? 'deli' },
      { staged: true },
    );
    const slices: number[] = [];
    const run = () => {
      const t = performance.now();
      const r = shop.staging?.next();
      slices.push(performance.now() - t);
      return !r || r.done;
    };
    const place = () => {
      const entry = entryOf(shop)!;
      // the street door: threshold at the origin, walking in faces -z (yaw 0)
      placementMatrix({ pos: new THREE.Vector3(0.6, 0, 0), yaw: 0 }, entry).decompose(shop.group.position, shop.group.quaternion, shop.group.scale);
      for (const o of entry.hide ?? []) o.visible = false;
      group.add(shop.group);
      group.userData.slices = slices.map((s) => +s.toFixed(1));
      console.info('[lab seamless] build slices (ms)', group.userData.slices);
    };
    // the facade: brick with a door and a display window cut out (z = 0 .. 0.35, street at +z)
    const brick = mat('#7a3b2e', { rough: 0.9 });
    const frame = mat('#1c1c1c', { rough: 0.45, metal: 0.35 });
    const W = 14, H = 5, T = 0.35;
    const doorX = 0.6, doorW = 1.1, doorH = 2.35;
    // the first slice lays out the shell: put the display window where the shop is wide enough
    run();
    const ent = entryOf(shop)!;
    const xs = shop.colliders().flatMap((r) => [r.minX, r.maxX]);
    const left = ent.pos.x - Math.min(...xs) - 0.3, right = Math.max(...xs) - ent.pos.x - 0.3;
    const onLeft = left >= right;
    const span = Math.min(3.2, Math.max(left, right) - 0.85);
    const winX0 = onLeft ? doorX - 0.75 - span : doorX + 0.75, winX1 = winX0 + span, sill = 0.6, winTop = 2.9;
    const wall = (x0: number, x1: number, y0: number, y1: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, T), brick);
      m.position.set((x0 + x1) / 2, (y0 + y1) / 2, T / 2);
      m.castShadow = m.receiveShadow = true;
      group.add(m);
    };
    // pavement in front only (the shop brings its own floor)
    const pave = new THREE.Mesh(new THREE.PlaneGeometry(40, 20), mat('#9a968e', { rough: 0.95 }));
    pave.rotation.x = -Math.PI / 2;
    pave.position.set(0, 0, 10);
    pave.receiveShadow = true;
    group.add(pave);
    // solid wall between the openings, and over them
    const cuts = [[winX0, winX1, sill, winTop], [doorX - doorW / 2, doorX + doorW / 2, 0, doorH]].sort((p, q) => p[0] - q[0]);
    let x = -W / 2;
    for (const [a0, a1, y0, y1] of cuts) {
      wall(x, a0, 0, H);
      if (y0 > 0) wall(a0, a1, 0, y0);
      wall(a0, a1, y1, H);
      x = a1;
    }
    wall(x, W / 2, 0, H);
    for (const [x, y, w, h] of [[winX0, sill, 0.08, winTop - sill], [winX1 - 0.08, sill, 0.08, winTop - sill], [doorX - doorW / 2, 0, 0.06, doorH], [doorX + doorW / 2 - 0.06, 0, 0.06, doorH]]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.12), frame);
      m.position.set(x + w / 2, y + h / 2, T - 0.06);
      group.add(m);
    }
    if (params.has('slices')) {
      return new Promise<void>((res) => {
        const tick = () => (run() ? (place(), res()) : requestAnimationFrame(tick));
        tick();
      });
    }
    while (!run());
    place();
    return shop.stocked;
  },
};
export default scene;
