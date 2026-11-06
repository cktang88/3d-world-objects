import * as THREE from 'three';
import type { LabScene } from '../lab';
import { gltf } from '../detail';

/**
 * ?lab=lod-compare&files=a.glb,b.glb,... — GLBs (urls relative to the site root, e.g. assets/vehicles/prius.glb)
 * side by side along x, each labelled by its triangle count in the console/userData. For judging LODs:
 *   &wire=1     overlay the triangle wireframe (density)
 *   &paint=#hex tint materials named PAINT (vehicle bodies are white in the files)
 *   &gap=m      spacing (default: largest width + 0.4 m)
 *   &nonormal=1 strip normal maps (see what the bake adds)
 * Result counts: window.__lodCompare = [{file, tris}].
 */
const scene: LabScene = {
  name: 'lod-compare',
  description: 'GLB LODs side by side (&files=a.glb,b.glb &wire=1 &paint=#hex)',
  cam: [-4.5, 2.2, -5.5],
  look: [0, 0.7, 0],
  env: 'studio',
  async build({ group, params }) {
    const files = (params.get('files') ?? 'assets/vehicles/prius.glb,assets/vehicles/prius_lod1.glb').split(',');
    const wire = params.get('wire') === '1';
    const paint = new THREE.Color(params.get('paint') ?? '#7d1a1a');
    const base = import.meta.env.BASE_URL;
    const loaded = await Promise.all(files.map((f) => gltf()!.loadAsync(/^https?:|^\//.test(f) ? f : base + f).catch(() => null)));
    const out: { file: string; tris: number }[] = [];
    let x = 0;
    const gap = params.has('gap') ? Number(params.get('gap')) : null;
    loaded.forEach((g, i) => {
      if (!g) return;
      const root = g.scene;
      let tris = 0;
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        tris += (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute('position').count) / 3;
        const mt = m.material as THREE.MeshStandardMaterial;
        if (mt.name === 'PAINT') {
          mt.color.copy(paint);
          mt.metalness = 0.5;
          mt.roughness = 0.35;
        }
        if (params.get('nonormal') === '1') mt.normalMap = null;
        if (wire) {
          const w = new THREE.Mesh(m.geometry, new THREE.MeshBasicMaterial({ color: '#000', wireframe: true, transparent: true, opacity: 0.35 }));
          m.add(w);
        }
      });
      const box = new THREE.Box3().setFromObject(root);
      const w = box.max.x - box.min.x;
      if (i) x += (gap ?? w + 0.4) / 2;
      root.position.x = x - (box.min.x + box.max.x) / 2;
      x += (gap ?? w + 0.4) / 2;
      group.add(root);
      out.push({ file: files[i], tris });
    });
    // centre the row
    const all = new THREE.Box3().setFromObject(group);
    const cx = (all.min.x + all.max.x) / 2;
    for (const c of group.children) c.position.x -= cx;
    (window as unknown as { __lodCompare: unknown }).__lodCompare = out;
    console.log('lod-compare', JSON.stringify(out));
  },
};
export default scene;
