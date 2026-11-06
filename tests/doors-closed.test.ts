/**
 * "Sometimes you see through walls when you close a storeroom or closet door": with a door shut, looking
 * at it from 0.3 m on either side, every ray through the doorway must hit something drawn (visible, opaque)
 * at the doorway (within 0.2 m past the door plane: the leaf), not the void behind. Covers the shop stockroom (from the shop and from inside the stockroom), interior closets and
 * cabinets (from the room), with the containers driven by lazy.ts as in the game.
 */
import * as THREE from 'three';
import { test, expect, fmt } from './qa';
import './env';
import { Lazy, type LazyContainer } from '../src/lazy';
import type { Level } from '../src/level';

const drawn = (o: THREE.Object3D) => {
  if ((o as THREE.Sprite).isSprite) return false;
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[];
  const mats = Array.isArray(m) ? m : [m];
  return mats.some((x) => x && !(x.transparent && x.opacity < 0.5) && x.colorWrite !== false);
};

/** rays from the eye through a grid over the doorway (obj frame: x in [-w/2, w/2], y in [y0, y1], z = 0) */
function leaks(root: THREE.Object3D, obj: THREE.Object3D, w: number, y0: number, y1: number, eye: THREE.Vector3) {
  root.updateMatrixWorld(true);
  const rc = new THREE.Raycaster();
  rc.camera = new THREE.PerspectiveCamera(); // (sprites need one)
  rc.far = 0.5 + 0.6;
  const out: string[] = [];
  for (let i = 0; i <= 8; i++)
    for (let j = 0; j <= 10; j++) {
      const lp = new THREE.Vector3(-w / 2 + 0.01 + (i / 8) * (w - 0.02), y0 + 0.01 + (j / 10) * (y1 - y0 - 0.02), 0);
      const target = obj.localToWorld(lp.clone());
      const dir = target.clone().sub(eye).normalize();
      rc.set(eye, dir);
      // something drawn at the doorway (the leaf), or before it: within 0.2 m past the door plane
      rc.far = eye.distanceTo(target) + 0.3;
      const all = rc.intersectObject(root, true);
      const hit = all.find((h) => drawn(h.object));
      const need = eye.distanceTo(target) + 0.2;
      if (!hit || hit.distance > need) out.push(`through (${fmt(lp.x)}, ${fmt(lp.y)}): ${hit ? `first surface at ${fmt(hit.distance)} m` : 'nothing'}${all[0] ? ` (hidden: ${all[0].object.name || all[0].object.type} at ${fmt(all[0].distance)})` : ''}`);
    }
  return out;
}

/** an eye 0.3 m in front of (side +1) or behind (side -1) the doorway's centre, at the door's mid height or eye height */
function eyeAt(obj: THREE.Object3D, side: number, y: number) {
  return obj.localToWorld(new THREE.Vector3(0, y, side * 0.3));
}

async function settleLazy(lazy: Lazy, lv: Level, cam: THREE.PerspectiveCamera, frames = 90) {
  for (let i = 0; i < frames; i++) lazy.update(1 / 30, cam, lv);
}

test('shop stockroom: shut, there is no seeing through its doorway, from the shop or from inside the stockroom', async () => {
  const { ShopLevel } = await import('../src/shop');
  const problems: string[] = [];
  let tried = 0;
  for (const shop of ['deli', 'bodega', 'hardware', 'pharmacy']) {
    const lv = new ShopLevel({ kind: 'interior', seed: 3, name: shop, style: 'store', floor: 0, floors: 1, biome: 'metropolis', shop });
    const sr = (lv as unknown as { stockroom?: { lazy?: LazyContainer } }).stockroom;
    if (!sr?.lazy) continue;
    tried++;
    const c = sr.lazy;
    const lazy = new Lazy();
    const cam = new THREE.PerspectiveCamera();
    // open it (the room is made), walk in, shut it behind you, look at the door
    cam.position.copy(eyeAt(c.obj, 1, 1.6));
    lazy.toggle(c);
    await settleLazy(lazy, lv, cam);
    for (const side of [1, -1]) {
      // (inside: in the middle of the stockroom, where you would stand)
      cam.position.copy(side > 0 ? eyeAt(c.obj, side, 1.6) : c.obj.localToWorld(new THREE.Vector3(0, 1.6, -1.2)));
      cam.updateMatrixWorld(true);
      if (c.open) lazy.toggle(c);
      await settleLazy(lazy, lv, cam, 60);
      if (c.t !== 0) problems.push(`${shop}: the door did not shut`);
      const where = side > 0 ? 'from the shop' : 'from inside the stockroom';
      for (const y of [1.6, 1.0]) {
        const l = leaks(lv.group, c.obj, 1.0, 0, 2.15, eyeAt(c.obj, side, y));
        if (l.length) problems.push(`${shop} stockroom ${where} (eye ${y} m): ${l.length} rays leak, e.g. ${l[0]}`);
      }
      if (side < 0) {
        // shut in: the stockroom around you is still there (walls, floor and ceiling in every direction)
        const rc = new THREE.Raycaster();
        rc.camera = cam;
        rc.far = 4;
        const eye = c.obj.localToWorld(new THREE.Vector3(0, 1.6, -1.2));
        lv.group.updateMatrixWorld(true);
        let open = 0;
        for (let a = 0; a < 24; a++)
          for (const up of [-0.6, 0, 0.6]) {
            rc.set(eye, new THREE.Vector3(Math.cos((a / 24) * Math.PI * 2), up, Math.sin((a / 24) * Math.PI * 2)).normalize());
            if (!rc.intersectObject(lv.group, true).some((h) => drawn(h.object))) open++;
          }
        if (open) problems.push(`${shop}: shut inside the stockroom, ${open} of 72 directions see nothing within 4 m (the room was hidden)`);
      }
      lazy.toggle(c); // open again for the other side
      await settleLazy(lazy, lv, cam, 60);
    }
    lv.dispose();
  }
  expect(tried > 0, 'no shop with a stockroom');
  expect(!problems.length, problems.slice(0, 8).join('\n'));
});

test('interior closets and cabinets: shut, the doors close the opening (looked at from 0.3 m)', async () => {
  const { InteriorLevel } = await import('../src/interior');
  const problems: string[] = [];
  let tried = 0;
  for (let seed = 1; seed < 12 && tried < 8; seed++) {
    const lv = new InteriorLevel({ kind: 'interior', seed, name: `a${seed}`, style: seed % 2 ? 'apartment' : 'house', floor: 0, floors: 1, biome: 'town' });
    const lazy = new Lazy();
    const cam = new THREE.PerspectiveCamera();
    lv.group.updateMatrixWorld(true);
    lazy.update(0, cam, lv);
    type C = { kind: string; obj: THREE.Object3D; size: THREE.Vector3; door?: THREE.Object3D; open?: unknown };
    for (const c of (lv as unknown as { containers: C[] }).containers) {
      if (!['closet', 'cabinet', 'fridge'].includes(c.kind) || !(c.door || c.open)) continue;
      tried++;
      // open, then shut, standing in front
      cam.position.copy(eyeAt(c.obj, 1, Math.min(1.6, c.size.y * 0.6)));
      cam.updateMatrixWorld(true);
      const hit = lazy.aim(new THREE.Ray(cam.position.clone(), c.obj.getWorldDirection(new THREE.Vector3()).negate()), 2, lv);
      if (!hit) continue;
      lazy.toggle(hit.c);
      await settleLazy(lazy, lv, cam, 40);
      lazy.toggle(hit.c);
      await settleLazy(lazy, lv, cam, 40);
      // the cells: all drawn for the check (lazy.ts culls rooms for this camera)
      for (const cell of (lv as unknown as { cells: { group: THREE.Object3D }[] }).cells ?? []) cell.group.visible = true;
      const l = leaks(lv.group, c.obj, c.size.x - 0.04, 0.03, c.size.y - 0.03, eyeAt(c.obj, 1, c.size.y * 0.5));
      if (l.length) problems.push(`${lv.name} ${c.kind}: ${l.length} rays leak, e.g. ${l[0]}`);
      if (tried >= 8) break;
    }
    lv.dispose();
  }
  expect(tried > 0, 'no closets or cabinets with doors');
  expect(!problems.length, problems.slice(0, 8).join('\n'));
});
