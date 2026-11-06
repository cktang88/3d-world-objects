import * as THREE from 'three';
import type { LabScene } from '../lab';
import { Person, Pedestrians, loadPeopleAssets, type Activity } from '../nyc/people';
import { Rng } from '../rng';
import { AX, AVE, SW, CURB } from '../nyc/common';

/**
 * ?lab=people — a lineup of pedestrians (walking in place) for close inspection.
 *   &mode=crowd   the full Pedestrians crowd around the origin (perf + behaviour)
 *   &act=walk|idle|phone|talk   activity for the lineup; &seed=N; &n=N; &t=seconds to pre-advance
 *   &face=back|side|front
 */
let people: Person[] = [];
let crowd: Pedestrians | null = null;
const origin = new THREE.Vector3();
const scene: LabScene = {
  name: 'people',
  description: 'Skinned, animated NYC pedestrians',
  cam: [0, 1.6, 7],
  look: [0, 1.0, 0],
  env: 'nyc',
  async build({ group, params }) {
    const assets = await loadPeopleAssets();
    if (params.get('mode') === 'crowd') {
      // stand on the east sidewalk of the avenue at x = 60 (sidewalk x 68..72.5); the lab origin
      // maps to that spot, so the default camera looks along the sidewalk
      origin.set(AX / 2 + AVE / 2 + 2, 0, 10);
      group.position.set(-origin.x, 0, -origin.z);
      const walk = new THREE.MeshStandardMaterial({ color: '#8d8a84', roughness: 0.9 });
      const road = new THREE.MeshStandardMaterial({ color: '#2a2b2e', roughness: 0.95 });
      for (const s of [-1, 1]) {
        const sw = new THREE.Mesh(new THREE.BoxGeometry(SW, CURB, 300), walk);
        sw.position.set(AX / 2 + s * (AVE / 2 + SW / 2), CURB / 2 + 0.002, origin.z);
        sw.receiveShadow = true;
        group.add(sw);
      }
      const rd = new THREE.Mesh(new THREE.BoxGeometry(AVE, 0.01, 300), road);
      rd.position.set(AX / 2, 0.006, origin.z);
      rd.receiveShadow = true;
      group.add(rd);
      crowd = new Pedestrians(group, Number(params.get('seed') ?? 1));
      await new Promise((r) => setTimeout(r, 50));
      crowd.update(0.016, origin);
      for (let i = 0; i < Number(params.get('t') ?? 0) * 10; i++) crowd.update(0.1, origin);
      // perf readout for shot.mjs --eval "__peopleStats()": meshes and triangles of the crowd
      (window as unknown as { __peopleStats: () => string }).__peopleStats = () => {
        let meshes = 0, tris = 0, shadow = 0;
        group.traverseVisible((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          const g = m.geometry;
          const t = (g.index ? g.index.count : g.attributes.position.count) / 3;
          meshes++;
          tris += t;
          if (m.castShadow) shadow += t;
        });
        return `people=${crowd!.peds.length} meshes=${meshes} tris=${Math.round(tris)} shadowTris=${Math.round(shadow)}`;
      };
      return;
    }
    const r = new Rng(Number(params.get('seed') ?? 3));
    const n = Number(params.get('n') ?? 8);
    const act = (params.get('act') ?? 'walk') as Activity;
    const face = params.get('face');
    people = [];
    for (let i = 0; i < n; i++) {
      const p = new Person(assets, r, i % 2 ? 'female' : 'male');
      p.root.position.set((i - (n - 1) / 2) * 0.9, 0, 0);
      p.root.rotation.y = face === 'back' ? Math.PI : face === 'side' ? Math.PI / 2 : 0;
      p.setActivity(act, i * 0.37);
      p.setShadows(true);
      if (params.get('lod')) p.setLod(Number(params.get('lod')));
      group.add(p.root);
      people.push(p);
    }
    const t = Number(params.get('t') ?? 0.4);
    for (const p of people) p.update(t);
  },
  update(dt) {
    for (const p of people) p.update(dt);
    crowd?.update(dt, origin);
  },
};
export default scene;
