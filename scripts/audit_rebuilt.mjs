#!/usr/bin/env node
/**
 * Audit public/rebuilt/*.glb against the size measured from each object's source USDA
 * (public/museum/s/<shard>.json, Y-up metres, same order as t/<shard>.json).
 *
 *   node scripts/audit_rebuilt.mjs [--json out.json] [--ids a,b] [--write-dims]
 *
 * --write-dims writes public/rebuilt/dims.json {id: [x, y, z]} (the USDA sizes of the rebuilt ids),
 * which src/remote.ts uses to refuse a rebuilt GLB whose size disagrees with its source.
 *
 * For each GLB: its bounding box (glTF Y-up, metres) vs the USDA size. "scale" mismatch: the
 * sorted dimensions differ by more than 1.2x (median ratio); "axes" mismatch: same sizes but in a
 * different axis order (e.g. lying on its side). Objects whose USDA size is unknown are skipped.
 */
import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : null);

/** id -> USDA size [x, y, z] (Y-up metres) */
export function usdaSizes(root = ROOT) {
  const out = new Map();
  const tdir = join(root, 'public/museum/t'), sdir = join(root, 'public/museum/s');
  for (const f of readdirSync(tdir)) {
    let t, s;
    try { t = JSON.parse(readFileSync(join(tdir, f), 'utf8')); s = JSON.parse(readFileSync(join(sdir, f), 'utf8')); } catch { continue; }
    for (const [theme, list] of Object.entries(t)) {
      const sz = s[theme] ?? [];
      list.forEach((e, i) => { if (Array.isArray(sz[i])) out.set(e[3], sz[i]); });
    }
  }
  return out;
}

/** compare a GLB size with the expected one: { scale: median ratio of sorted dims, axes: same order? } */
export function compare(got, want) {
  const ratios = [0, 1, 2].map((i) => got[i] / Math.max(want[i], 1e-6));
  const gs = [...got].sort((a, b) => a - b), ws = [...want].sort((a, b) => a - b);
  const sorted = [0, 1, 2].map((i) => gs[i] / Math.max(ws[i], 1e-6)).sort((a, b) => a - b);
  const scale = sorted[1];
  // axes: per-axis ratios agree with the sorted ones (allowing near-equal dims to swap)
  const spread = (r) => Math.max(...r) / Math.max(Math.min(...r), 1e-9);
  const axesOk = spread(ratios) < Math.max(1.35, spread(sorted) * 1.35);
  return { scale, axesOk, ratios };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const sizes = usdaSizes();
  const only = arg('--ids')?.split(',');
  const files = readdirSync(join(ROOT, 'public/rebuilt')).filter((f) => f.endsWith('.glb') && (!only || only.includes(f.slice(0, -4))));
  const rows = [];
  let unknown = 0;
  for (const f of files) {
    const id = f.slice(0, -4);
    const want = sizes.get(id);
    if (!want) { unknown++; continue; }
    const doc = await io.read(join(ROOT, 'public/rebuilt', f));
    const b = getBounds(doc.getRoot().listScenes()[0]);
    const got = [0, 1, 2].map((i) => b.max[i] - b.min[i]);
    const c = compare(got, want);
    rows.push({ id, got: got.map((v) => +v.toFixed(3)), want, scale: +c.scale.toFixed(3), axesOk: c.axesOk });
  }
  const badScale = rows.filter((r) => r.scale > 1.2 || r.scale < 1 / 1.2);
  const badAxes = rows.filter((r) => !r.axesOk);
  const hist = {};
  for (const r of badScale) { const k = `x${Math.round(Math.log10(r.scale) * 10) / 10 >= 0 ? '' : ''}${(+r.scale.toPrecision(2))}`; hist[k] = (hist[k] ?? 0) + 1; }
  console.log(`audit: ${files.length} GLBs, ${rows.length} with a USDA size (${unknown} unknown)`);
  console.log(`  scale mismatch (>1.2x): ${badScale.length}`);
  console.log(`  axis-order mismatch:    ${badAxes.length}`);
  console.log('  worst:', [...badScale].sort((a, b) => Math.abs(Math.log(b.scale)) - Math.abs(Math.log(a.scale))).slice(0, 8).map((r) => `${r.id} x${r.scale} got ${r.got} want ${r.want}`).join('\n         '));
  console.log('  axes e.g.:', badAxes.slice(0, 6).map((r) => `${r.id} got ${r.got} want ${r.want}`).join('\n            '));
  if (process.argv.includes('--write-dims')) {
    const dims = {};
    for (const f of readdirSync(join(ROOT, 'public/rebuilt')).filter((f) => f.endsWith('.glb'))) { const v = sizes.get(f.slice(0, -4)); if (v) dims[f.slice(0, -4)] = v; }
    writeFileSync(join(ROOT, 'public/rebuilt/dims.json'), JSON.stringify(dims));
    console.log(`wrote public/rebuilt/dims.json (${Object.keys(dims).length} ids)`);
  }
  if (arg('--json')) writeFileSync(arg('--json'), JSON.stringify({ rows, badScale: badScale.map((r) => r.id), badAxes: badAxes.map((r) => r.id) }, null, 1));
}
