import * as THREE from 'three';
import type { LabScene } from '../lab';
import { loadMuseum, museum } from '../museumData';
import { GalleryLevel } from '../museum/gallery';
import { AtriumLevel } from '../museum/atrium';

/**
 * ?lab=museum-room&theme=<n>&page=<p>   one gallery room alone (theme by id, or &q=<name part>)
 * ?lab=museum-room&atrium=1             the atrium
 * Camera defaults to the entrance at eye height, looking in; &far=1 looks from a high corner.
 */
let lv: GalleryLevel | AtriumLevel | null = null;
const scene: LabScene = {
  name: 'museum-room',
  description: 'one museum room built alone: &theme=<id> or &q=<name>, &page=, &atrium=1, &far=1',
  cam: [0, 1.6, -1.2],
  look: [0, 1.5, -12],
  env: 'museum',
  ground: false,
  async build({ group, params, camera }) {
    await loadMuseum();
    const m = museum();
    let theme = Number(params.get('theme') ?? m.wings[0].theme);
    const q = params.get('q')?.toLowerCase();
    if (q) theme = m.themes.find((t) => t.name.toLowerCase().includes(q) || t.collection.toLowerCase().includes(q))?.id ?? theme;
    lv = params.has('atrium') ? new AtriumLevel() : new GalleryLevel({ kind: 'gallery', theme, page: Number(params.get('page') ?? 0) });
    group.add(lv.group);
    const w = window as unknown as { __room: unknown; __lv: unknown };
    w.__lv = lv;
    await Promise.race([lv.ready, new Promise((r) => setTimeout(r, Number(params.get('maxwait') ?? 60000)))]);
    if (lv instanceof GalleryLevel && lv.plan) {
      const p = lv.plan;
      w.__room = { theme: lv.theme.name, collection: lv.theme.collection, arch: lv.style.arch, W: +p.W.toFixed(1), D: +p.D.toFixed(1), H: +p.H.toFixed(1), ceiling: p.ceiling, floor: p.floorKind, units: [...p.floor, ...p.wall, ...p.hang].map((x) => `${x.u.type}:${x.u.items.length}`).join(' ') };
      if (!params.has('cam') && params.has('far')) {
        camera.position.set(p.W / 2 - 0.8, Math.min(p.H - 0.5, 6), -0.8);
        camera.lookAt(new THREE.Vector3(-p.W / 5, 0.8, -p.D * 0.65));
      }
    }
  },
  update(dt, time) {
    lv?.update(dt, new THREE.Vector3(0, 1.6, -2), time);
  },
};
export default scene;
