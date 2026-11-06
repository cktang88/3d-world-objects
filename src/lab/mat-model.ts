import * as THREE from 'three';
import type { LabScene } from '../lab';
import { loadRemote, type RemoteEntry } from '../remote';
import { materialsReady, setBakeStrength, setDust, setEdgeWear, setMaterialDebug } from '../materials';

/**
 * ?lab=mat-model — rebuilt sand3d objects (public/rebuilt) side by side, for material work.
 *   &ids=objaverse-…,objaverse-…   (default: the baked test set from scripts/rebuild.py --bake)
 *   &bake=0     ignore the baked AO    &wear=1  edge wear from the baked convexity      &dust=0.6     &dbg=1..5 (see setMaterialDebug)
 */
export const BAKED_TEST_SET = [
  'objaverse-056ccf898f9e49acb6e3e370deabf184', // gas stove: painted metal, brushed steel, plastics
  'objaverse-ae0529d9da834820b8a9c30ec0b6228f', // upright piano: walnut, brass, plastic
  'objaverse-5e1f7a56da4a4dab8ad64efd46ed9d9f', // wooden dining chair: oak
  'objaverse-5c06813c8bdc40bb8e4f257ed92ad6fa', // old train seats: leather, painted metal
  'objaverse-0f370dedfa5d43c8b14658dfc5c46273', // beach chair: fabric, walnut
  'objaverse-296b7d6b6fd24030b31b1041e877612b', // pot: ceramic
  'objaverse-808d6f532c5b4b28bccd4e7a21003176', // padlock: brass, steel
  'objaverse-293ff3d013f049fab1e17a6085ea317a', // gaming mic: chrome, brushed steel, paint
];

const scene: LabScene = {
  name: 'mat-model',
  description: 'rebuilt objects in a row for material work (&ids=, &bake=0, &dust=, &dbg=)',
  cam: [0, 1.6, 4.2],
  look: [0, 0.6, 0],
  async build({ group, params }) {
    const ids = params.get('ids')?.split(',') ?? BAKED_TEST_SET;
    setBakeStrength(Number(params.get('bake') ?? 1));
    setDust(Number(params.get('dust') ?? 0));
    setEdgeWear(Number(params.get('wear') ?? 0));
    setMaterialDebug(Number(params.get('dbg') ?? 0));
    const models = await Promise.all(ids.map((id) => loadRemote({ id, joints: 0 } as RemoteEntry).catch(() => null)));
    const gap = Number(params.get('gap') ?? 0.25);
    const ok = models.filter((m): m is NonNullable<typeof m> => !!m);
    // big things (the piano) scaled down to ~1.6 m so everything fits one frame; each placed by
    // its bounding box (rebuilt GLBs are not centred)
    const boxes = ok.map((m) => {
      const b = new THREE.Box3().setFromObject(m.object);
      const sz = b.getSize(new THREE.Vector3());
      const s = Math.min(1, 1.6 / Math.max(sz.x, sz.y, sz.z));
      return { b, sz, s };
    });
    const width = boxes.reduce((w, { sz, s }) => w + sz.x * s + gap, -gap);
    let x = -width / 2;
    ok.forEach((m, i) => {
      const { b, sz, s } = boxes[i];
      const c = b.getCenter(new THREE.Vector3());
      const holder = new THREE.Group();
      m.object.position.set(-c.x, -b.min.y, -c.z);
      holder.add(m.object);
      holder.scale.setScalar(s);
      holder.position.set(x + (sz.x * s) / 2, 0, 0);
      x += sz.x * s + gap;
      group.add(holder);
    });
    await materialsReady();
    group.userData.bounds = new THREE.Box3().setFromObject(group);
  },
};
export default scene;
