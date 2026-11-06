import * as THREE from 'three';
import type { LabScene } from '../lab';
import { InteriorLevel } from '../interior';
import { Lazy } from '../lazy';

/**
 * ?lab=drawers — an apartment's library dresser (or nightstand) with a drawer pulled out and its
 * contents generated on opening (lazy.ts). &kind=dresser|nightstand &seed= start seed, &n= which drawer (0..), &all=1 opens the piece's others too.
 */
type C = { kind: string; obj: THREE.Group; size: THREE.Vector3; drawer?: THREE.Object3D; hideClosed?: boolean };

const scene: LabScene = {
  name: 'drawers',
  description: 'a library dresser with a drawer open (contents made on opening)',
  env: 'studio',
  ground: false,
  build({ group, params }) {
    const want = Number(params.get('n') ?? 0);
    let lv: InteriorLevel | null = null, pick: C | null = null;
    const found: C[] = [];
    for (let seed = Number(params.get('seed') ?? 1); seed < 200 && !pick; seed++) {
      lv?.dispose();
      lv = new InteriorLevel({ kind: 'interior', seed, name: `Lab ${seed}`, style: seed % 2 ? 'apartment' : 'house', floor: 0, floors: 1, biome: 'town' });
      found.length = 0;
      for (const c of (lv as unknown as { containers: C[] }).containers) if (c.hideClosed && c.drawer && c.kind === (params.get('kind') ?? 'dresser')) found.push(c);
      if (found.length > want) pick = found[want];
    }
    if (!lv || !pick) return;
    group.add(lv.group);
    lv.group.updateMatrixWorld(true);
    // open it (all drawers of this piece with &all=1) the way E does
    const lazy = new Lazy();
    const cam = new THREE.PerspectiveCamera();
    lazy.update(0.1, cam, lv);
    const toOpen = params.has('all') ? found.filter((c) => c.obj.position.distanceTo(pick!.obj.position) < 1.2) : [pick];
    for (const c of toOpen) {
      const ray = new THREE.Ray(c.obj.localToWorld(new THREE.Vector3(0, c.size.y / 2, 1.0)), c.obj.getWorldDirection(new THREE.Vector3()).negate());
      const hit = lazy.aim(ray, 2.4, lv);
      if (hit) lazy.toggle(hit.c);
    }
    for (let i = 0; i < 40; i++) lazy.update(1 / 30, cam, lv);
    // lazy.update also culls rooms for its (dummy) camera: show them all again
    for (const c of (lv as unknown as { cells: { group: THREE.Object3D }[] }).cells ?? []) c.group.visible = true;
    // camera: 1.5 m in front of the drawer and a little to the side, looking at it
    const front = pick.obj.localToWorld(new THREE.Vector3(0.45, 1.45, 1.7));
    const at = pick.obj.localToWorld(new THREE.Vector3(0, pick.size.y * 0.4, 0.2));
    (window as unknown as { __drawers: unknown }).__drawers = { kind: pick.kind, at: at.toArray(), cam: front.toArray(), travel: pick.drawer?.position.z, visible: pick.drawer?.visible, contents: pick.obj.children.length };
    group.userData.cam = front;
    group.userData.look = at;
    group.userData.env = lv.env;
    group.userData.place = 'interior';
    // no ceiling, so the studio light gets in from above too
    lv.group.traverse((o) => { if (o.userData.ceiling) o.visible = false; });
  },
};
export default scene;
