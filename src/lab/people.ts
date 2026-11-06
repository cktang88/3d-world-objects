import * as THREE from 'three';
import type { LabScene } from '../lab';
import { Person, Pedestrians, loadPeopleAssets, peopleWeather, type Activity } from '../nyc/people';
import { Rng } from '../rng';
import { AX, AVE, SW, CURB, SZ, ST } from '../nyc/common';
import type { Rect } from '../level';

/**
 * ?lab=people — a lineup of pedestrians (walking in place) for close inspection.
 *   &mode=crowd   the full Pedestrians crowd around the origin (perf + behaviour)
 *   &act=walk|idle|phone|talk   activity for the lineup; &seed=N; &n=N; &t=seconds to pre-advance
 *   &face=back|side|front
 */
let people: Person[] = [];
let crowd: Pedestrians | null = null;
const origin = new THREE.Vector3();
let labCols: Rect[] = [];
let labTime = 0;
let skelPerFrame = 0, skelLast = 0;
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
      const box = (w: number, h: number, d: number, x: number, y: number, z: number, m: THREE.Material) => {
        const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
        b.position.set(x, y, z);
        b.receiveShadow = true;
        group.add(b);
        return b;
      };
      // the avenue (x = 60) meets a street (z = 32): sidewalks stop at the street's kerbs
      const sz = SZ / 2;
      for (const s of [-1, 1]) {
        box(SW, CURB, sz - ST / 2 + 120, AX / 2 + s * (AVE / 2 + SW / 2), CURB / 2, (sz - ST / 2 - 120) / 2, walk);
        box(SW, CURB, 120, AX / 2 + s * (AVE / 2 + SW / 2), CURB / 2, sz + ST / 2 + 60, walk);
      }
      box(AVE, 0.01, 300, AX / 2, 0.006, origin.z, road);
      box(80, 0.012, ST, AX / 2, 0.007, sz, road);
      const paint = new THREE.MeshStandardMaterial({ color: '#e8e8e4', roughness: 0.7 });
      for (const zs of [-1, 1]) for (let x = AX / 2 - AVE / 2 + 0.5; x < AX / 2 + AVE / 2; x += 1.2) box(0.6, 0.014, 3, x, 0.008, sz + zs * (ST / 2 + 1.9), paint);
      for (const xs of [-1, 1]) for (let z = sz - ST / 2 + 0.5; z < sz + ST / 2; z += 1.2) box(3, 0.014, 0.6, AX / 2 + xs * (AVE / 2 + 1.9), 0.008, z, paint);
      // street furniture on the east sidewalk to walk around: tree pits and a newsstand
      const cols: Rect[] = [];
      const furn = new THREE.MeshStandardMaterial({ color: '#3a4a3a', roughness: 0.8 });
      for (const [x, z, w, d, h] of [[69.2, 2, 1.1, 1.1, 0.4], [69.2, 12, 1.1, 1.1, 0.4], [69.2, 20, 1.1, 1.1, 0.4], [70.6, -8, 1.9, 4.6, 2.4], [69.0, 25, 0.5, 0.5, 1.1]]) {
        box(w, h, d, x, CURB + h / 2, z, furn);
        cols.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
      }
      labCols = cols;
      labTime = Number(params.get('time') ?? 0);
      crowd = new Pedestrians(group, Number(params.get('seed') ?? 1));
      await new Promise((r) => setTimeout(r, 50));
      crowd.update(0.016, origin, labTime, labCols);
      for (let i = 0; i < Math.max(12, Number(params.get('t') ?? 0) * 10); i++) crowd.update(0.1, origin, (labTime += 0.1), labCols);
      crowd.warmUp();
      crowd.update(0.016, origin, (labTime += 0.016), labCols);
      // perf readout for shot.mjs --eval "__peopleStats()": meshes and triangles of the crowd
      (window as unknown as { __peopleStats: () => string }).__peopleStats = () => {
        let meshes = 0, tris = 0, shadow = 0, farN = 0;
        group.traverseVisible((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          const g = m.geometry;
          const inst = (m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1;
          if (inst > 1 || (m as THREE.InstancedMesh).isInstancedMesh) farN += inst;
          const t = ((g.index ? g.index.count : g.attributes.position.count) / 3) * inst;
          meshes++;
          tris += t;
          if (m.castShadow) shadow += t;
        });
        const vis = crowd!.peds.filter((d) => d.p.root.visible).length;
        return `people=${crowd!.peds.length} visible=${vis} far=${farN} meshes=${meshes} tris=${Math.round(tris)} shadowTris=${Math.round(shadow)} skeletonUpdates/frame=${skelPerFrame.toFixed(1)} vatBakeMs=${(globalThis as unknown as { __peopleBakeMs?: number }).__peopleBakeMs}`;
      };
      return;
    }
    const r = new Rng(Number(params.get('seed') ?? 3));
    const n = Number(params.get('n') ?? 8);
    const act = (params.get('act') ?? 'walk') as Activity;
    const face = params.get('face');
    people = [];
    for (let i = 0; i < n; i++) {
      // &want=dog|stroller|carry|slow: re-roll until the person has it (lab only)
      const want = params.get('want');
      const gen = (i: number) => (params.get('g') === 'male' ? 'male' : params.get('g') === 'female' ? 'female' : i % 2 ? 'female' : 'male');
      let p = new Person(assets, r, gen(i));
      for (let k = 0; k < 200 && want && !(want === 'dog' ? p.dog : want === 'stroller' ? p.noPhone && !p.dog : want === 'slow' ? p.slow : want === 'hat' ? p.hasHat : !!p.pose); k++) p = new Person(assets, r, gen(i));
      p.root.position.set((i - (n - 1) / 2) * 0.9, 0, 0);
      p.root.rotation.y = face === 'back' ? Math.PI : face === 'side' ? Math.PI / 2 : 0;
      p.setActivity(act, i * 0.37);
      p.applyWeather(peopleWeather);
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
    crowd?.update(dt, origin, (labTime += dt), labCols);
    if (crowd) {
      skelPerFrame = skelPerFrame * 0.9 + (Person.skeletonUpdates - skelLast) * 0.1;
      skelLast = Person.skeletonUpdates;
    }
  },
};
export default scene;
