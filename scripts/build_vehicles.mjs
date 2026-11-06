#!/usr/bin/env node
/**
 * Build the traffic fleet: CC-BY car models from Objaverse/Sketchfab -> public/assets/vehicles/<id>.glb (+ _lod1.glb).
 *
 *   node scripts/build_vehicles.mjs <dir with raw <uid>.glb files> [id ...]
 *
 * Raw files come from https://huggingface.co/datasets/allenai/objaverse (glbs/<group>/<uid>.glb); credits in CREDITS.md.
 * Per model: drop unwanted parts, tag the body paint material "PAINT" (base colour -> white so it can be tinted at
 * runtime) and glass "GLASS", turn the car so its nose points to -z, scale it to its real length, centre it on x/z and
 * stand it on y=0, then flatten/join/weld, simplify (LOD0 and a far LOD1), shrink textures to webp and meshopt-compress.
 */
import { NodeIO, getBounds, PropertyType } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, flatten, join, weld, simplify, prune, textureCompress, meshopt, resample, sparse } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier, MeshoptDecoder } from 'meshoptimizer';
import { fixFile } from './coplanar-scan.mjs';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
// mesh-simplification skill: attribute-aware near LOD at one shared world-space error (see .claude/skills/mesh-simplification)
import { simplifyDocument } from './lib/simplify-doc.mjs';

/**
 * yaw: radians turning the raw model so its nose points -z (after the bbox's long axis is put on z)
 * len: real length in metres; paint/glass/drop: material-name regexps
 * tris: LOD0 triangle target; lod1: LOD1 target
 */
export const FLEET = [
  { id: 'taxi_cv', uid: '2429a825ff1646568e8e6e1453f9c501', len: 5.38, yaw: Math.PI, paint: null, glass: /^glass/, drop: /interior/, tris: 30000, lod1: 5000 },
  { id: 'prius', uid: 'aa599d492d3d4618a1bf5f3786e1bbd9', len: 4.54, yaw: Math.PI, paint: /^dbl_boot_ok_002_ncl1_1$|^dbl_bonnet_ok_002$/, glass: /^material_0$/, drop: /interior|Belt/, tris: 40000, lod1: 6000 },
  { id: 'accord', uid: '1e3be91c28104f6489b42248884327fe', len: 4.93, yaw: Math.PI, paint: /^Body_Color$|^0136_Charcoal$/, glass: /Glass/, drop: /Leather|Interior|Carpet|Sophie|LCD|Wood/, tris: 40000, lod1: 6000, near: 22000 },
  { id: 'charger', uid: '2f69495ce4e040878237eb7f46e7029e', len: 5.08, yaw: Math.PI, paint: /^material$/, glass: null, drop: /^material_65$/, tris: 40000, lod1: 6000, near: 18000, far: 3000 },
  // no window glass in this model: { id: 'tahoe', uid: '8b1db1daad3f4c1fafd41f9a36511855', len: 5.13, yaw: 0, paint: /^Paint_/, glass: /Glass/i, drop: /^Interior/, tris: 40000, lod1: 6000 },
  { id: 'suburban', uid: 'b01950cf99aa48c1ba2ebd0addc8a9d4', len: 5.7, yaw: Math.PI, paint: /^default$/, glass: /^blackplast1$/, drop: /^tree$|^inter01$|^stuf$/, tris: 40000, lod1: 6000, near: 20000 },
  { id: 'escalade', uid: '7c5516c76bd441d998af76e2240a2b8d', len: 5.14, yaw: Math.PI, paint: null, glass: /Platinum23Mtl$/, drop: null, tris: 40000, lod1: 6000 },
  { id: 'explorer', uid: 'a47d2d8c83b44d348329dba8f92d1adc', len: 5.05, yaw: Math.PI, paint: /wire_187200200|Exterior_01/, glass: /Glass/, drop: null, tris: 40000, lod1: 6000 },
  { id: 'accord19', uid: 'aad70ad7eae3467e99c71ef0c7150138', len: 4.88, yaw: Math.PI, paint: /^Platinum_White_Metallic$/, glass: /Glass/, drop: /^edge_color|^BlackTrim$/, tris: 45000, lod1: 6000, err0: 0.02, weld0: true },
  { id: 'sprinter', uid: 'f69de1315bb049c8946d57f6006acd73', len: 5.9, yaw: Math.PI, paint: null, glass: /vitre|glass/i, drop: /Interrieur/, tris: 30000, lod1: 5000 },
  // { id: 'lexus', uid: '6f2f754c78794734b794237913ba97cc', len: 4.76, yaw: 0, paint: null, glass: null, drop: null, tris: 40000, lod1: 6000 },
];

const TRIS = { near: 25000, mid: 4500, far: 2000 };
// LODS=0,1 rebuilds only those levels
const LODS = (process.env.LODS ?? '0,1,2').split(',').map(Number);
const OUT = process.env.OUT ?? path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public', 'assets', 'vehicles');
// LOD method: 'attr' = simplifyDocument for every level (shared error, rebuilt crease normals, twin triangles dropped);
// 'legacy' = per-primitive ratio simplify (near LODs stuck at 25-61k on seams); 'none' = unsimplified near LOD (comparison source)
const NEAR = process.env.NEAR ?? 'attr';
const NEAR_TRIS = Number(process.env.NEAR_TRIS ?? 14000);
// per-car overrides (attr mode): near / mid / far triangle targets (FLEET entries: near, mid, far)

async function main() {
  const dir = process.argv[2];
  const only = process.argv.slice(3);
  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;
  await MeshoptSimplifier.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
  fs.mkdirSync(OUT, { recursive: true });
  for (const cfg of FLEET) {
    if (only.length && !only.includes(cfg.id)) continue;
    for (const lod of LODS) {
      const doc = await io.read(path.join(dir, `${cfg.uid}.glb`));
      const root = doc.getRoot();
      // no animation/skins/cameras/lights in traffic cars
      root.listAnimations().forEach((a) => a.dispose());
      root.listSkins().forEach((s) => s.dispose());
      // drop parts and tag paint/glass
      for (const m of root.listMeshes())
        for (const p of m.listPrimitives()) {
          const mt = p.getMaterial();
          const name = mt?.getName() ?? '';
          if (cfg.drop && cfg.drop.test(name)) p.dispose();
          else if (p.getMode() !== 4) p.dispose(); // lines/points (edge_color strokes)
        }
      for (const mt of root.listMaterials()) {
        const name = mt.getName();
        if (cfg.paint && cfg.paint.test(name)) {
          mt.setName('PAINT');
          mt.setBaseColorFactor([1, 1, 1, 1]);
        } else if ((cfg.glass && cfg.glass.test(name)) || mt.getAlphaMode() === 'BLEND') {
          mt.setName('GLASS');
        }
      }
      await doc.transform(prune());
      // orient, scale, centre, ground
      const scene = root.listScenes()[0];
      const pivot = doc.createNode('vehicle');
      for (const c of scene.listChildren()) {
        scene.removeChild(c);
        pivot.addChild(c);
      }
      scene.addChild(pivot);
      let b = getBounds(scene);
      const sx = b.max[0] - b.min[0], sz = b.max[2] - b.min[2];
      const yaw = (sx > sz ? Math.PI / 2 : 0) + cfg.yaw;
      pivot.setRotation([0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]);
      b = getBounds(scene);
      const k = cfg.len / (b.max[2] - b.min[2]);
      pivot.setScale([k, k, k]);
      b = getBounds(scene);
      const t = [-(b.min[0] + b.max[0]) / 2, -b.min[1], -(b.min[2] + b.max[2]) / 2];
      const outer = doc.createNode('root').setTranslation(t);
      scene.removeChild(pivot);
      outer.addChild(pivot);
      scene.addChild(outer);
      // budgets: near ~15k (within 15 m), mid ~4.5k (to 40 m), far ~2k
      const target = [TRIS.near, TRIS.mid, TRIS.far][lod];
      await doc.transform(dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.MESH, PropertyType.TEXTURE] }), flatten(), join({ keepNamed: false }), weld({}));
      const tris = count(root);
      if (NEAR === 'attr' || (NEAR === 'none' && lod > 0)) {
        // every LOD at one shared world-space error (bisected to the budget), normals rebuilt with 35° creases
        // error caps (m): the near LOD may stay over budget rather than visibly melt (accord19's 400k source stops at ~24k)
        const r = await simplifyDocument(doc, { targetTris: [cfg.near ?? NEAR_TRIS, cfg.mid ?? Number(process.env.MID_TRIS ?? 7000), cfg.far ?? target][lod], normals: 'rebuild', creaseDeg: 35, dropUv: lod === 2, maxError: [0.03, 0.15, 0.5][lod], sloppyFallback: lod > 0 });
        console.log(cfg.id, 'lod', lod, 'shared error', (r.error * 1000).toFixed(2), 'mm', r.sloppy ? '+ sloppy fallback' : '');
      } else if (NEAR !== 'none') {
        const ratio = Math.min(1, target / count(root));
        if (ratio < 1) await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio, error: lod === 0 ? (cfg.err0 ?? 0.005) : 0.02, lockBorder: false }));
        // seams (uv/normal splits) stop the simplifier early: for the far LOD drop normals (and uvs of untextured
        // parts), weld by position alone and simplify again; normals are recomputed at load
        // (the near LOD only for models whose triangles are all unwelded, flag weld0: welding blurs their hard edges)
        if (count(root) > target * 1.15 && (lod > 0 || cfg.weld0)) {
          for (const m of root.listMeshes())
            for (const p of m.listPrimitives()) {
              p.setAttribute('NORMAL', null);
              const mt = p.getMaterial();
              // the far LOD is drawn vertex-coloured (texture averages), so it needs no uvs at all: weld across seams
              if (lod === 2 || !mt?.getBaseColorTexture()) for (const s of p.listSemantics()) if (s !== 'POSITION') p.setAttribute(s, null);
            }
          await doc.transform(weld({}));
          const now = count(root);
          await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: Math.min(1, target / now), error: [0.006, 0.04, 0.09][lod], lockBorder: false }));
        }
      }
      await doc.transform(
        prune(),
        textureCompress({ encoder: sharp, targetFormat: 'webp', resize: lod === 0 ? [1024, 1024] : lod === 1 ? [256, 256] : [64, 64] }),
        meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
      );
      const file = path.join(OUT, `${cfg.id}${lod ? '_lod' + lod : ''}.glb`);
      await io.write(file, doc);
      // no coplanar overlapping triangles (z-fighting: "two textures overlapping"): scan and fix every file
      const zf = await fixFile(file);
      if (zf.after.pairs) throw new Error(`${file}: ${zf.after.pairs} coplanar overlaps left after the fix`);
      if (zf.first.pairs) console.log(cfg.id, 'lod', lod, `z-fight fix: ${zf.first.pairs} overlapping pairs -> 0`);
      const sz2 = getBounds(scene);
      console.log(cfg.id, 'lod', lod, 'tris', tris, '->', count(root), 'mats', root.listMaterials().length, 'size', sz2.max.map((v, i) => (v - sz2.min[i]).toFixed(2)).join('x'), (fs.statSync(file).size / 1024) | 0, 'KB');
    }
  }
}

function count(root) {
  let n = 0;
  for (const m of root.listMeshes()) for (const p of m.listPrimitives()) n += (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3;
  return Math.round(n);
}

main();
