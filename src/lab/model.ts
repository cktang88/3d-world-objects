import * as THREE from 'three';
import type { LabScene } from '../lab';
import { allModels, spawn, normScale } from '../assets';
import { loadRemote } from '../remote';
import { loadOriginal } from '../detail';
import { museum, themeMembers } from '../museumData';

/**
 * ?lab=model&id=<sand3d id>            one bundled world model (or any id in a museum room: &theme=<n>&i=<k>)
 * &original=1 also shows the Objaverse original next to it.
 */
const scene: LabScene = {
  name: 'model',
  description: 'one sand3d object: &id= (bundled) or &theme=&i= (museum room), &original=1',
  cam: [2.2, 1.4, 2.6],
  look: [0, 0.5, 0],
  async build({ group, params }) {
    const id = params.get('id');
    const local = id ? allModels().find((m) => m.id === id) : allModels()[Number(params.get('n') ?? 0)];
    if (local && !params.has('theme')) {
      const sp = spawn(local, normScale(local));
      group.add(sp.obj);
      await new Promise((r) => setTimeout(r, 1500));
      return;
    }
    const t = Number(params.get('theme') ?? museum().wings[0].theme);
    const all = await themeMembers(t);
    const e = all[Number(params.get('i') ?? 0)];
    const m = await loadRemote(e);
    group.add(m.object);
    if (params.has('original')) {
      const o = await loadOriginal(e.id, e.og, m.size);
      if (o) {
        o.position.x = m.size.x * 1.3;
        group.add(o);
      }
    }
    const box = new THREE.Box3().setFromObject(group);
    group.userData.bounds = box;
  },
};
export default scene;
