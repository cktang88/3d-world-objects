#!/usr/bin/env node
/**
 * Triangle / attribute / bbox census of GLB files (meshopt, Draco-free).
 *
 *   node scripts/mesh_stats.mjs public/assets/vehicles/*.glb [--json]
 *
 * Prints per file: triangles, primitives, materials, materials with a normal map, attribute
 * semantics present and the world-space bbox size. Used by the mesh-simplification skill to
 * measure LOD chains before/after.
 */
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const json = process.argv.includes('--json');
const out = [];
for (const f of process.argv.slice(2).filter((a) => !a.startsWith('--'))) {
  const doc = await io.read(f);
  const root = doc.getRoot();
  let tris = 0, prims = 0;
  const attrs = new Set(), mats = new Set();
  for (const n of root.listNodes()) {
    const m = n.getMesh();
    if (!m) continue;
    for (const p of m.listPrimitives()) {
      prims++;
      tris += (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3;
      p.listSemantics().forEach((s) => attrs.add(s));
      mats.add(p.getMaterial());
    }
  }
  const nrm = [...mats].filter((m) => m?.getNormalTexture()).length;
  const b = getBounds(root.listScenes()[0]);
  const size = b.max.map((v, i) => +(v - b.min[i]).toFixed(3));
  const r = { file: f.split('/').pop(), tris: Math.round(tris), prims, mats: mats.size, normalMaps: nrm, attrs: [...attrs].sort(), size };
  out.push(r);
  if (!json) console.log(r.file.padEnd(28), String(r.tris).padStart(8), 'tris', 'prims', prims, 'mats', mats.size, 'nrmMaps', nrm, r.attrs.join(','), size.join('x'));
}
if (json) console.log(JSON.stringify(out, null, 1));
