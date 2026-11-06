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
    // where to aim (taken now: the drawers are refitted to the model's own fronts once it loads)
    const rays = (params.has('all') ? found.filter((c) => c.obj.position.distanceTo(pick!.obj.position) < 1.2) : [pick]).map(
      (c) => new THREE.Ray(c.obj.localToWorld(new THREE.Vector3(0, c.size.y / 2, 1.0)), c.obj.getWorldDirection(new THREE.Vector3()).negate()),
    );
    const level = lv;
    const p0 = pick;
    // the library model streams in (then libDrawerSet refits the drawers): wait, then open the way E does
    // until the piece's first drawers are replaced by the refitted ones (or &wait= ms, default 60 s)
    const originals = found.filter((c) => c.obj.position.distanceTo(pick!.obj.position) < 1.5);
    const t0 = performance.now(), cap = Number(params.get('wait') ?? 60000);
    const refitted = () => new Promise<void>((res) => {
      const poll = () => (originals.every((c) => !c.obj.parent) || performance.now() - t0 > cap ? res() : setTimeout(poll, 300));
      poll();
    });
    return refitted().then(() => {
      const lazy = new Lazy();
      const cam = new THREE.PerspectiveCamera();
      lazy.update(0.1, cam, level);
      for (const ray of rays) {
        const hit = lazy.aim(ray, 2.4, level);
        if (hit) lazy.toggle(hit.c);
      }
      for (let i = 0; i < 40; i++) lazy.update(1 / 30, cam, level);
      finish(level, p0);
    });
  },
};
export default scene;

function finish(lv: InteriorLevel, p: C) {
  const group = lv.group.parent!;
  // lazy.update also culls rooms for its (dummy) camera: show them all again
  for (const c of (lv as unknown as { cells: { group: THREE.Object3D }[] }).cells ?? []) c.group.visible = true;
  // camera: 1.5 m in front of the drawer and a little to the side, looking at it
  const front = p.obj.localToWorld(new THREE.Vector3(0.45, 1.45, 1.7));
  const at = p.obj.localToWorld(new THREE.Vector3(0, p.size.y * 0.4, 0.2));
  const mine = (lv as unknown as { containers: C[] }).containers.filter((c) => c.hideClosed && c.obj.parent && c.obj.getWorldPosition(new THREE.Vector3()).distanceTo(at) < 1.5);
  (window as unknown as { __drawers: unknown }).__drawers = { refit: mine.map((c) => [c.obj.position.y.toFixed(2), c.size.x.toFixed(2), c.size.y.toFixed(2), c.drawer?.position.z.toFixed(2)]), kind: p.kind, at: at.toArray(), cam: front.toArray(), travel: p.drawer?.position.z, visible: p.drawer?.visible, contents: p.obj.children.length };
  group.userData.cam = front;
  group.userData.look = at;
  group.userData.env = lv.env;
  group.userData.place = 'interior';
  // no ceiling, so the studio light gets in from above too
  lv.group.traverse((o) => { if (o.userData.ceiling) o.visible = false; });
}

