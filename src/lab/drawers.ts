import * as THREE from 'three';
import type { LabScene } from '../lab';
import { InteriorLevel } from '../interior';
import { Lazy, type LazyContainer } from '../lazy';
import { readFront } from '../lazy-furniture';

/**
 * ?lab=drawers — an apartment's library dresser (or nightstand) with a drawer pulled out and its
 * contents generated on opening (lazy.ts). &kind=dresser|nightstand &seed= start seed, &n= which piece's drawer (0..),
 * &all=1 opens the piece's other drawers too, &open=doors|drawers|all opens the refitted ones.
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
    // the library model streams in; the openings are cut when you come close (lazy.ts prepare): wait for
    // the model (&wait= ms cap, default 60 s), then do what walking up to it does, then open (&open=)
    const prep = (pick as C & { prepare?: (() => LazyContainer[] | null) & { ready?: () => boolean } }).prepare;
    const t0 = performance.now(), cap = Number(params.get('wait') ?? 60000);
    const loaded = () => new Promise<void>((res) => {
      const poll = () => (!prep?.ready || prep.ready() || performance.now() - t0 > cap ? res() : setTimeout(poll, 300));
      poll();
    });
    // as walking up to it does: start the read and cut in idle slices, wait for them
    const prepared = () => new Promise<LazyContainer[]>((res) => {
      const poll = () => {
        const r = prep?.() ?? null;
        if (r || !prep || performance.now() - t0 > cap) res(r ?? []);
        else setTimeout(poll, 50);
      };
      poll();
    });
    return loaded().then(() => {
      // (lazy.ts adopts the level's containers first, so the refitted ones get registered)
      new Lazy().update(0, new THREE.PerspectiveCamera(), level);
      return prepared();
    }).then((made) => {
      const lazy = new Lazy();
      const cam = new THREE.PerspectiveCamera();
      lazy.update(0.1, cam, level);
      const opened: LazyContainer[] = [];
      const which = params.get('open');
      if (which && prep) {
        // the refitted drawers and doors: &open=doors|drawers|all|none
        void made;
        // the read timed again, warmed up (the first one in a page includes the JIT): window.__drawers.warmMs
        let holder: THREE.Object3D | null = null;
        level.group.traverse((o) => { if (o.userData.attribution && o.position.distanceTo(p0.obj.position) < 1.0) holder = o; });
        if (holder) {
          const h = holder as THREE.Object3D;
          const box = new THREE.Box3().setFromObject(h.children[0]).applyMatrix4(h.matrixWorld.clone().invert());
          const size = box.getSize(new THREE.Vector3()).toArray();
          const ms: number[] = [];
          for (let i = 0; i < 5; i++) ms.push(readFront(h.children[0], h, size).ms);
          (window as unknown as { __warmMs: number[] }).__warmMs = ms.map((x) => +x.toFixed(2));
        }
        rays.length = 0;
        for (const c of made) {
          if (which === 'none' || (which === 'doors' && !c.spec.door) || (which === 'drawers' && !c.spec.drawer)) continue;
          lazy.toggle(c);
          opened.push(c);
        }
      }
      for (const ray of rays) {
        const hit = lazy.aim(ray, 2.4, level);
        if (hit && !opened.includes(hit.c)) {
          lazy.toggle(hit.c);
          opened.push(hit.c);
        }
      }
      for (let i = 0; i < 40; i++) lazy.update(1 / 30, cam, level);
      finish(level, p0);
      // what is in the open ones (window.__drawers.opened): meshes, and their box in the container's frame
      (window as unknown as { __drawers: { opened?: unknown } }).__drawers.opened = opened.map((c) => {
        let meshes = 0;
        c.contents?.traverse((o) => ((o as THREE.Mesh).isMesh ? meshes++ : 0));
        const b = c.contents ? new THREE.Box3().setFromObject(c.contents).applyMatrix4(c.obj.matrixWorld.clone().invert()) : null;
        return { label: c.label, t: +c.t.toFixed(2), meshes, visible: c.contents?.visible, box: b && [b.min.toArray(), b.max.toArray()].map((v) => v.map((x) => +x.toFixed(2))) };
      });
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

