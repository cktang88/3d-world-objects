import * as THREE from 'three';
import type { LabScene } from '../lab';
import { loadCatalog, loadLibraryModel } from '../libraries';
import { ScreenLOD, lodTris } from '../meshlod';
import { loadOriginal } from '../detail';
import { museum, themeMembers } from '../museumData';

/**
 * ?lab=lod-runtime — runtime screen-space LODs (src/meshlod.ts) on a streamed scan: the same Smithsonian model
 * at 1.5, 6 and 24 m from the camera (scaled to 1 m). &cat=<smithsonian category> &i=<index>, &px=<allowed pixels; 0 = originals>.
 * &orig=<theme>:<i> uses a museum member's Objaverse original (loadOriginal) instead.
 * window.__lodRuntime = [{ dist, level, tris }] once built (levels are picked at render time).
 */
let cam: THREE.Camera | null = null;
const copies: { d: number; obj: THREE.Object3D }[] = [];
const scene: LabScene = {
  name: 'lod-runtime',
  description: 'runtime LOD chain on a Smithsonian scan at 3 distances (&cat= &i=)',
  cam: [0, 0.8, 0],
  look: [0, 0.6, -10],
  env: 'museum',
  async build({ group, params, camera }) {
    cam = camera;
    if (params.has('px')) ScreenLOD.pixels = Number(params.get('px')); // 0 = always the original
    const t0 = performance.now();
    let model: THREE.Object3D;
    let title: string;
    if (params.has('orig')) {
      // &orig=<museum theme>:<member index>: that member's Objaverse original through detail.ts (addLods inside)
      const [th, k] = params.get('orig')!.split(':').map(Number);
      const e = (await themeMembers(Number.isFinite(th) ? th : museum().wings[0].theme))[k || 0];
      const o = await loadOriginal(e.id, e.og, new THREE.Vector3(1, 1, 1));
      if (!o) throw new Error('no original for ' + e.id);
      model = o;
      title = e.id;
    } else {
      const all = await loadCatalog('smithsonian', params.get('cat') ?? 'african-art');
      const e = all[Number(params.get('i') ?? 0)];
      model = await loadLibraryModel(e, { maxDim: 1 });
      title = e.title;
    }
    const ms = performance.now() - t0;
    [1.5, 6, 24].forEach((d, k) => {
      const o = k ? model.clone(true) : model;
      o.position.set((k - 1) * 0.6 * (d / 6), 0, -d);
      group.add(o);
      copies.push({ d, obj: o });
    });
    const lods: number[] = [];
    model.traverse((o) => o instanceof ScreenLOD && lods.push(o.levels.length));
    console.log('lod-runtime', title, 'load+lod ms', Math.round(ms), 'tris', lodTris(model), 'lods', JSON.stringify(lods));
  },
  update() {
    if (!cam) return;
    (window as unknown as { __lodRuntime: unknown }).__lodRuntime = copies.map(({ d, obj }) => {
      let level = -1, tris = 0;
      obj.traverse((o) => {
        if (o instanceof ScreenLOD) {
          level = Math.max(level, o.getCurrentLevel());
          const m = o.levels[o.getCurrentLevel()].object as THREE.Mesh;
          tris += m.geometry.index!.count / 3;
        }
      });
      return { dist: d, level, tris, full: lodTris(obj) };
    });
  },
};
export default scene;
