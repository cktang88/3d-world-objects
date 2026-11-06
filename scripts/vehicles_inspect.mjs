// node scripts/vehicles_inspect.mjs file.glb ... : per material colour, texture use, triangles and world bbox (scratch helper)
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const mul = (m, v) => [0, 1, 2].map((i) => m[i] * v[0] + m[4 + i] * v[1] + m[8 + i] * v[2] + m[12 + i]);
for (const f of process.argv.slice(2)) {
  const doc = await io.read(f);
  const root = doc.getRoot();
  const info = new Map();
  let all = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const wm = node.getWorldMatrix();
    for (const p of mesh.listPrimitives()) {
      const k = p.getMaterial()?.getName() ?? '(none)';
      const pos = p.getAttribute('POSITION');
      const n = (p.getIndices()?.getCount() ?? pos.getCount()) / 3;
      const e = info.get(k) ?? { tris: 0, b: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity] };
      e.tris += n;
      const v = [0, 0, 0];
      for (let i = 0; i < pos.getCount(); i += 7) {
        const w = mul(wm, pos.getElement(i, v));
        for (let a = 0; a < 3; a++) {
          e.b[a] = Math.min(e.b[a], w[a]); e.b[a + 3] = Math.max(e.b[a + 3], w[a]);
          all[a] = Math.min(all[a], w[a]); all[a + 3] = Math.max(all[a + 3], w[a]);
        }
      }
      info.set(k, e);
    }
  }
  const S = [0, 1, 2].map((a) => all[a + 3] - all[a]);
  console.log('==', f.split('/').pop(), 'size', S.map((v) => v.toFixed(2)).join('x'));
  for (const mt of root.listMaterials()) {
    const e = info.get(mt.getName());
    if (!e || e.tris < 50) continue;
    const c = mt.getBaseColorFactor().map((v) => v.toFixed(2)).join(' ');
    const rel = [0, 1, 2].map((a) => ((e.b[a + 3] - e.b[a]) / S[a]).toFixed(2)).join('x');
    console.log(`  ${mt.getName().slice(0, 40).padEnd(40)} col=${c} tex=${mt.getBaseColorTexture() ? 'Y' : '-'} tris=${Math.round(e.tris)} relsize=${rel}`);
  }
}
