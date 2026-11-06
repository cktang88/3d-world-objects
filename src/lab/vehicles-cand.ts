import * as THREE from 'three';
import type { LabScene } from '../lab';
import { gltf } from '../detail';

/** ?lab=vehicles-cand&files=a,b,c&dir=_cand — raw candidate GLBs in a row, normalised to 4.8 m long. */
const scene: LabScene = {
  name: 'vehicles-cand',
  description: 'candidate vehicle GLBs side by side (&files=uid,uid&dir=)',
  cam: [0, 4, 14],
  look: [0, 1, 0],
  env: 'nyc',
  async build({ group, params }) {
    const dir = params.get('dir') ?? '_cand';
    const files = (params.get('files') ?? '').split(',').filter(Boolean);
    const len = Number(params.get('len') ?? 4.8);
    const info: string[] = [];
    await Promise.all(
      files.map(async (f, i) => {
        const g = await gltf()!.loadAsync(`/${dir}/${f}.glb`);
        const o = g.scene;
        const box = new THREE.Box3().setFromObject(o);
        const s = box.getSize(new THREE.Vector3());
        const k = len / Math.max(s.x, s.z);
        o.scale.setScalar(k);
        const c = box.getCenter(new THREE.Vector3());
        const w = new THREE.Group();
        o.position.set(-c.x * k, -box.min.y * k, -c.z * k);
        w.add(o);
        w.position.x = (i - (files.length - 1) / 2) * 5.5;
        group.add(w);
        let tris = 0;
        o.traverse((m) => {
          const mesh = m as THREE.Mesh;
          if (mesh.isMesh) {
            mesh.castShadow = true;
            const gi = mesh.geometry.index;
            tris += (gi ? gi.count : mesh.geometry.getAttribute('position').count) / 3;
          }
        });
        info.push(`${i} ${f} size=${s.toArray().map((v) => v.toFixed(2))} tris=${tris}`);
      }),
    );
    (window as any).__candInfo = info;
  },
};
export default scene;
