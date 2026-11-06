/** NYC districts: every showcase slot rests on something (ground, deck, table, plinth), boats sit at the waterline. */
// default: a few representative blocks; QA_DISTRICTS=all for every special block
import * as THREE from 'three';
import { test, none, fmt } from './qa';
import { nycChunk } from './world';
import { slotsUnder, type SlotSpec } from '../src/nyc/district-showcase';

const ALL: [string, number, number][] = [
  ['park fountain', 0, -4], ['park pond', 1, -4], ['park playground', -1, -4], ['park ballfield', 2, -4], ['park dogrun', -1, -5], ['park garden', 1, -5], ['park meadow', 0, -5], ['park kiosk', 2, -5],
  ['auto row', 4, -4], ['construction', 4, -1], ['rail yard', 5, -1], ['greenmarket', -2, 2], ['museum', -2, -5], ['bowery', 1, 2], ['canal', -1, 2], ['brownstone', -2, 0], ['times sq', 2, -3], ['flea market', 3, -1], ['salvage yard', 5, -1],
  ['pier shed', 6, 0], ['pier aircraft', 6, 1], ['pier marina', 6, -1], ['carrier', 7, -1], ['airport stands', -3, -2], ['airport hangar', -4, -3], ['airport ramp', -3, -1],
];
const SPECIAL = process.env.QA_DISTRICTS === 'all' ? ALL : ALL.filter(([n]) => /^(park pond|park fountain|auto row|pier marina|greenmarket|carrier|airport stands|flea market|salvage yard)$/.test(n));
const kinds = (s: SlotSpec) => (Array.isArray(s.kind) ? s.kind : [s.kind]).join('/');
const isBoat = (s: SlotSpec) => kinds(s).split('/').includes('boat');

/** the block's solid meshes: everything that is not a showcase holder, a sprite or a tree batch */
function supports(root: THREE.Object3D) {
  const out: THREE.Object3D[] = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (o as THREE.BatchedMesh).isBatchedMesh) return;
    let p: THREE.Object3D | null = o;
    while (p) { if (p.userData.showcase) return; p = p.parent; }
    out.push(o);
  });
  return out;
}

test('showcase slots rest on a surface (gap <= 3 cm), boats at the waterline', () => {
  const bad: string[] = [];
  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  for (const [name, cx, cz] of SPECIAL) {
    const c = nycChunk(1, cx, cz);
    const meshes = supports(c.group);
    for (const s of slotsUnder(c.group)) {
      const y = s.y ?? 0;
      // from 5 cm above the object's base straight down: the first surface is what it stands on
      // (boats: from above the hull, so the first surface is the water around it)
      ray.set(new THREE.Vector3(s.x, y + (isBoat(s) ? 1.5 : 0.05), s.z), down);
      ray.far = 40;
      const hit = ray.intersectObjects(meshes, false).find((h) => (h.face?.normal ? h.face.normal.clone().transformDirection(h.object.matrixWorld).y > 0.5 : true));
      const top = hit ? hit.point.y : -Infinity;
      const gap = y - top;
      if (isBoat(s)) {
        // a hull floats with its bottom a little below the water surface
        if (!(gap <= -0.05 && gap >= -0.8)) bad.push(`${name}: boat at ${fmt(s.x)},${fmt(s.z)}: keel ${fmt(-gap)} m below the surface under it (y ${fmt(y)}, surface ${fmt(top)})`);
      } else if (!(gap <= 0.03 && gap >= -0.05)) bad.push(`${name}: ${kinds(s)} at ${fmt(s.x)},${fmt(s.z)} y ${fmt(y)}: ${gap > 0 ? 'floats' : 'sunk'} ${fmt(Math.abs(gap))} m (surface ${fmt(top)})`);
    }
  }
  none(bad, 'slots not resting on a surface', String, Number(process.env.QA_SHOW ?? 12));
});
