import * as THREE from 'three';
import type { LabScene } from '../lab';
import { Person, Pedestrians, loadPeopleAssets, type Activity } from '../nyc/people';
import { Rng } from '../rng';

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
      crowd = new Pedestrians(group, Number(params.get('seed') ?? 1));
      await new Promise((r) => setTimeout(r, 50));
      crowd.update(0.016, origin);
      for (let i = 0; i < Number(params.get('t') ?? 0) * 10; i++) crowd.update(0.1, origin);
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
