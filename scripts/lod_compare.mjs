#!/usr/bin/env node
/**
 * Geometric error of a LOD against its source, in world units (both GLBs in the same frame):
 *
 *   node scripts/lod_compare.mjs source.glb lod.glb [more_lods.glb ...] [--samples 6000]
 *
 * Per LOD: triangles, bbox size delta, and surface distance both ways (sampled, grid-accelerated):
 *   lost  = source -> lod (detail the LOD no longer covers: thin parts pruned, dents filled)
 *   added = lod -> source (spikes/bulges the LOD adds)
 *   seen  = what a viewer sees: z-buffered from 14 directions, silhouette mismatch and depth error of
 *           visible surfaces (hidden inner shells cannot count; the number to trust)
 * reported as max and mean, absolute and relative to the source's largest dimension.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { surfaceDistance, usedBox, viewError } from '../src/meshlod-core.ts';

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

/** every triangle of a GLB in world space as one indexed soup */
export async function worldMesh(file) {
  const doc = await io.read(file);
  const P = [], I = [];
  let base = 0;
  const el = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const p of mesh.listPrimitives()) {
      if (p.getMode() !== 4) continue;
      const pos = p.getAttribute('POSITION');
      const n = pos.getCount();
      for (let i = 0; i < n; i++) {
        pos.getElement(i, el);
        P.push(m[0] * el[0] + m[4] * el[1] + m[8] * el[2] + m[12], m[1] * el[0] + m[5] * el[1] + m[9] * el[2] + m[13], m[2] * el[0] + m[6] * el[1] + m[10] * el[2] + m[14]);
      }
      const ix = p.getIndices()?.getArray() ?? Uint32Array.from({ length: n }, (_, i) => i);
      for (let i = 0; i < ix.length; i++) I.push(ix[i] + base);
      base += n;
    }
  }
  return { pos: new Float32Array(P), idx: new Uint32Array(I) };
}

const args = process.argv.slice(2);
const si = args.indexOf('--samples');
const samples = si >= 0 ? Number(args.splice(si, 2)[1]) : 6000;
if (import.meta.url === `file://${process.argv[1]}`) {
  const [src, ...lods] = args;
  const a = await worldMesh(src);
  const ba = usedBox(a.pos, a.idx);
  const size = Math.max(ba[3] - ba[0], ba[4] - ba[1], ba[5] - ba[2]);
  console.log(src.split('/').pop(), a.idx.length / 3, 'tris, size', size.toFixed(3));
  for (const f of lods) {
    const b = await worldMesh(f);
    const bb = usedBox(b.pos, b.idx);
    const dbox = Math.max(...[0, 1, 2, 3, 4, 5].map((k) => Math.abs(bb[k] - ba[k])));
    const lost = surfaceDistance(a.pos, a.idx, b.pos, b.idx, samples);
    const added = surfaceDistance(b.pos, b.idx, a.pos, a.idx, samples);
    const mm = (v) => (v * 1000).toFixed(1);
    const ve = viewError(a.pos, a.idx, b.pos, b.idx, 200);
    console.log(
      `  ${f.split('/').pop().padEnd(26)} ${String(b.idx.length / 3).padStart(7)} tris  bbox±${mm(dbox)}  lost max ${mm(lost.max)} mean ${mm(lost.mean)}  added max ${mm(added.max)} mean ${mm(added.mean)}  (x1e-3 units; rel max ${((Math.max(lost.max, added.max) / size) * 100).toFixed(2)}%)\n    seen from 14 views: silhouette ${(ve.silhouette * 100).toFixed(2)}%  depth mean ${mm(ve.depthMean)} p95 ${mm(ve.depthP95)}  (pixel ${mm(ve.pixel)})`,
    );
  }
}
