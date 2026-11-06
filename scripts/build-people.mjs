#!/usr/bin/env node
/**
 * Build the pedestrian assets in public/assets/people/ from Quaternius' CC0 packs:
 *   - Universal Base Characters [Standard]  https://quaternius.itch.io/universal-base-characters
 *   - Universal Animation Library [Standard] https://quaternius.itch.io/universal-animation-library
 *
 *   node scripts/build-people.mjs <UBC "Universal Base Characters[Standard]" dir> <UAL "Universal Animation Library[Standard]" dir>
 *
 * Outputs (meshopt + webp, textures ≤1024):
 *   male.glb, female.glb  skinned bodies (65-bone UE-style skeleton) + eyes + eyebrows, light skin texture
 *   hair.glb              hairstyles and beard as static meshes in bind-pose world space
 *   anims.glb             a few locomotion/idle clips, no meshes, scale tracks removed
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { mergeDocuments, unpartition, prune, dedup, textureCompress, meshopt, resample, clearNodeTransform, clearNodeParent } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

const [ubc, ual] = process.argv.slice(2);
if (!ubc || !ual) throw new Error('usage: build-people.mjs <ubc dir> <ual dir>');
const OUT = path.resolve('public/assets/people');
fs.mkdirSync(OUT, { recursive: true });
await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

const finish = async (doc, file, size = 1024) => {
  await doc.transform(unpartition());
  await doc.transform(
    prune(),
    dedup(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [size, size], quality: 82 }),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  await io.write(path.join(OUT, file), doc);
  console.log(file, (fs.statSync(path.join(OUT, file)).size / 1e6).toFixed(2), 'MB');
};

// ---- bodies
const bodies = path.join(ubc, 'Base Characters', 'Godot - UE');
const tex = path.join(ubc, 'Base Characters', 'Textures');
for (const [g, light] of [['Male', 'T_Superhero_Male_Ligh.png'], ['Female', 'T_Superhero_Female_Light_BaseColor.png']]) {
  // a few image uris in the gltf name files that are not shipped in that folder
  for (const [a, b] of [['T_Hair_1_Normal.png', 'T_Hair_1_Normal_png.png'], ['T_Eye_Normal.png', 'T_Eye_Normal_png.png']])
    if (!fs.existsSync(path.join(bodies, b))) fs.copyFileSync(path.join(bodies, a), path.join(bodies, b));
  const doc = await io.read(path.join(bodies, `Superhero_${g}_FullBody.gltf`));
  const root = doc.getRoot();
  for (const m of root.listMaterials()) {
    if (/Superhero/.test(m.getName())) m.getBaseColorTexture().setImage(fs.readFileSync(path.join(tex, light))).setMimeType('image/png');
  }
  // a low-poly LOD of the body (same skin, ~20 % of the triangles) for people far away
  const bodyNode = root.listNodes().find((n) => n.getMesh()?.listPrimitives().some((p) => /Superhero/.test(p.getMaterial()?.getName() ?? '')));
  const prim = bodyNode.getMesh().listPrimitives()[0];
  const lp = prim.clone();
  for (const sem of lp.listSemantics()) lp.setAttribute(sem, lp.getAttribute(sem).clone());
  const pos = lp.getAttribute('POSITION').getArray();
  const idx = new Uint32Array(lp.getIndices().getArray());
  const [lod] = MeshoptSimplifier.simplify(idx, new Float32Array(pos), 3, Math.floor(idx.length * 0.2 / 3) * 3, 0.02, ['LockBorder']);
  lp.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(lod)));
  const lodNode = doc.createNode('Body_LOD').setMesh(doc.createMesh('Body_LOD').addPrimitive(lp)).setSkin(bodyNode.getSkin());
  (bodyNode.getParentNode() ?? root.listScenes()[0]).addChild(lodNode);
  console.log(g, 'LOD tris', lod.length / 3, 'of', idx.length / 3);
  await finish(doc, `${g.toLowerCase()}.glb`);
}

// ---- hair: one document, one node per style, transforms baked so vertices sit in bind-pose world space
{
  const dir = path.join(ubc, 'Hairstyles', 'Origin at 0', 'glTF (Godot)');
  const merged = await io.read(path.join(dir, 'Hair_Buzzed.gltf'));
  const scene = merged.getRoot().getDefaultScene() ?? merged.getRoot().listScenes()[0];
  const names = ['Hair_BuzzedFemale', 'Hair_Buns', 'Hair_Long', 'Hair_SimpleParted', 'Hair_Beard'];
  for (const n of names) {
    const d = await io.read(path.join(dir, `${n}.gltf`));
    mergeDocuments(merged, d);
  }
  const root = merged.getRoot();
  // move every mesh node to the first scene with its world transform baked in
  for (const s of root.listScenes()) for (const n of s.listChildren()) if (s !== scene) { s.removeChild(n); scene.addChild(n); }
  for (const s of root.listScenes()) if (s !== scene) s.dispose();
  for (const n of root.listNodes()) if (n.getParentNode()) clearNodeParent(n);
  for (const n of root.listNodes()) if (n.getMesh()) clearNodeTransform(n);
  await finish(merged, 'hair.glb');
}

// ---- animations
{
  const keep = ['Walk_Loop', 'Walk_Formal_Loop', 'Idle_Loop', 'Idle_Talking_Loop', 'Jog_Fwd_Loop', 'Sitting_Idle_Loop'];
  const doc = await io.read(path.join(ual, 'Unreal-Godot', 'UAL1_Standard.glb'));
  const root = doc.getRoot();
  for (const a of root.listAnimations()) {
    if (!keep.includes(a.getName())) {
      for (const c of a.listChannels()) c.dispose();
      for (const sm of a.listSamplers()) sm.dispose();
      a.dispose();
      continue;
    }
    for (const c of a.listChannels()) {
      const p = c.getTargetPath(), name = c.getTargetNode()?.getName() ?? '';
      if (p === 'scale') { c.getSampler()?.dispose(); c.dispose(); continue; }
      // bone translations would impose the mannequin's bone lengths on our bodies: keep only root/pelvis
      if (p === 'translation' && !/^(root|pelvis)$/.test(name)) { c.getSampler()?.dispose(); c.dispose(); continue; }
      // fingers barely move in these clips: hold them at their first key
      if (/^(index|middle|pinky|ring|thumb)_/.test(name)) {
        const s = c.getSampler(), inp = s.getInput(), out = s.getOutput();
        const k = out.getElementSize();
        const v = out.getArray().slice(0, k);
        s.setInput(doc.createAccessor().setType('SCALAR').setArray(new Float32Array([inp.getArray()[0]])));
        s.setOutput(doc.createAccessor().setType(out.getType()).setArray(new Float32Array(v)));
        s.setInterpolation('STEP');
      }
    }
  }
  for (const n of root.listNodes()) n.setMesh(null);
  for (const m of root.listMeshes()) m.dispose();
  for (const s of root.listSkins()) s.dispose();
  await doc.transform(resample({ tolerance: 1e-4 }));
  await finish(doc, 'anims.glb');
}
