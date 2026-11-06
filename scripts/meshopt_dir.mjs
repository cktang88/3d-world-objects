#!/usr/bin/env node
/**
 * Meshopt-compress every GLB of a folder in one process (what `npx gltf-transform meshopt`
 * does per file, without paying the CLI's start-up per object). Skips outputs that exist.
 *
 *   node scripts/meshopt_dir.mjs in_dir out_dir [--copy public/rebuilt]
 */
import { readdirSync, existsSync, mkdirSync, copyFileSync, statSync } from 'fs';
import { join } from 'path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';

const [inDir, outDir] = process.argv.slice(2);
const copyTo = process.argv.includes('--copy') ? process.argv[process.argv.indexOf('--copy') + 1] : null;
await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
mkdirSync(outDir, { recursive: true });
let n = 0, fail = 0, big = 0;
for (const f of readdirSync(inDir).filter((f) => f.endsWith('.glb') && !f.endsWith('.part.glb')).sort()) {
  const out = join(outDir, f);
  if (existsSync(out)) continue;
  try {
    const doc = await io.read(join(inDir, f));
    await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'high' }));
    await io.write(out, doc);
    if (statSync(out).size > 8 << 20) { big++; console.log('too big (>8 MB), not copied', f); continue; }
    if (copyTo) copyFileSync(out, join(copyTo, f));
    n++;
  } catch (e) {
    fail++;
    console.log('meshopt fail', f, String(e).slice(0, 200));
  }
}
console.log(`meshopt: ${n} new, ${fail} failed, ${big} too big`);
