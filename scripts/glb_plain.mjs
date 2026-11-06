// GLB -> plain GLB for Blender (no meshopt, no quantization). --clean also drops back-to-back twin triangles and fixes inverted normals (do it before a normal bake).
//   node scripts/glb_plain.mjs in.glb out.glb [--clean]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { dequantize } from '@gltf-transform/functions';
import { dropTwinTriangles, fixInvertedNormals } from './lib/simplify-doc.mjs';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const [i, o, flag] = process.argv.slice(2);
const doc = await io.read(i);
for (const e of doc.getRoot().listExtensionsUsed()) if (/meshopt|quantization/.test(e.extensionName)) e.dispose();
await doc.transform(dequantize());
if (flag === '--clean') console.log('twins', dropTwinTriangles(doc, true), 'flipped', fixInvertedNormals(doc));
await io.write(o, doc);
console.log('plain', o);
