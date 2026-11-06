/**
 * Materials: rebuilt GLBs (public/rebuilt, scripts/rebuild.py) carry metric UVs (1 UV unit = 1 m,
 * so photo textures tile at real size) and, once rebaked with --bake, a COLOR_0 bake
 * (R = AO, G = convexity). Plus kind names parse.
 *
 *   npm run qa -- materials        (QA_MAT_ALL=1 checks every rebuilt GLB, not a sample)
 */
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { NodeIO, type Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { test, expect, none, soft, fmt } from './qa';
import './env';
import { kindOf } from '../src/materials';

const ROOT = process.env.QA_ROOT ?? process.cwd();
const DIR = join(ROOT, 'public', 'rebuilt');
/** the hand-checked bake test set (same as BAKED_TEST_SET in src/lab/mat-model.ts) */
const BAKED = [
  'objaverse-056ccf898f9e49acb6e3e370deabf184', 'objaverse-ae0529d9da834820b8a9c30ec0b6228f',
  'objaverse-5e1f7a56da4a4dab8ad64efd46ed9d9f', 'objaverse-5c06813c8bdc40bb8e4f257ed92ad6fa',
  'objaverse-0f370dedfa5d43c8b14658dfc5c46273', 'objaverse-296b7d6b6fd24030b31b1041e877612b',
  'objaverse-808d6f532c5b4b28bccd4e7a21003176', 'objaverse-293ff3d013f049fab1e17a6085ea317a',
];

let io: NodeIO | null = null;
async function read(id: string): Promise<Document> {
  if (!io) {
    await MeshoptDecoder.ready;
    io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  }
  return io.readBinary(new Uint8Array(readFileSync(join(DIR, `${id}.glb`))));
}

interface Stat { id: string; ratio: number; color: boolean; prims: number }
/** UV span / world size, per mesh; returns the median ratio over the object's meshes */
function stats(id: string, doc: Document): Stat {
  const ratios: number[] = [];
  let color = true, prims = 0;
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    const sx = Math.hypot(m[0], m[1], m[2]), sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10]);
    for (const p of mesh.listPrimitives()) {
      prims++;
      if (!p.getAttribute('COLOR_0')) color = false;
      const pos = p.getAttribute('POSITION'), uv = p.getAttribute('TEXCOORD_0');
      if (!pos || !uv) continue;
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      const ulo = [Infinity, Infinity], uhi = [-Infinity, -Infinity];
      const a: number[] = [], b: number[] = [];
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, a);
        for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], a[k]); hi[k] = Math.max(hi[k], a[k]); }
      }
      for (let i = 0; i < uv.getCount(); i++) {
        uv.getElement(i, b);
        for (let k = 0; k < 2; k++) { ulo[k] = Math.min(ulo[k], b[k]); uhi[k] = Math.max(uhi[k], b[k]); }
      }
      const ext = Math.max((hi[0] - lo[0]) * sx, (hi[1] - lo[1]) * sy, (hi[2] - lo[2]) * sz);
      const span = Math.max(uhi[0] - ulo[0], uhi[1] - ulo[1]);
      if (ext > 1e-3 && span > 0) ratios.push(span / ext);
    }
  }
  ratios.sort((x, y) => x - y);
  return { id, ratio: ratios.length ? ratios[ratios.length >> 1] : NaN, color, prims };
}

test('kind names parse (USD "oak__6e4a32" and GLB "oak #6e4a32 roughness=0.4")', () => {
  expect(kindOf('oak__6e4a32') === 'oak', 'oak__');
  expect(kindOf('brushed_steel #9aa0a6 roughness=0.35') === 'brushed_steel', 'brushed_steel #');
  expect(kindOf('glass__ffffff') === 'glass', 'glass');
  expect(kindOf('default') === null, 'unknown kind');
});

test('bake test set: COLOR_0 on every primitive and metric UVs (span/size 0.2..5)', async () => {
  const bad: Stat[] = [];
  for (const id of BAKED) {
    expect(existsSync(join(DIR, `${id}.glb`)), `${id}.glb exists`);
    const s = stats(id, await read(id));
    if (!s.color || !(s.ratio > 0.2 && s.ratio < 5)) bad.push(s);
  }
  none(bad, 'test-set GLBs without bake or with non-metric UVs', (s) => `${s.id} ratio=${fmt(s.ratio)} color=${s.color}`);
});

test('rebaked GLBs (those with COLOR_0) all have metric UVs; report how many are still mm-UV', async () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.glb')).sort();
  const all = process.env.QA_MAT_ALL === '1';
  // a deterministic sample keeps this well under the per-test time limit
  const pick = all ? files : files.filter((_, i) => i % Math.max(1, Math.floor(files.length / 40)) === 0);
  const bad: Stat[] = [];
  let baked = 0, mm = 0;
  for (const f of pick) {
    const id = f.slice(0, -4);
    const s = stats(id, await read(id));
    if (!Number.isFinite(s.ratio)) continue;
    if (s.color) {
      baked++;
      if (!(s.ratio > 0.2 && s.ratio < 5)) bad.push(s);
    } else if (s.ratio > 100) mm++;
  }
  none(bad, 'baked GLBs with non-metric UVs', (s) => `${s.id} ratio=${fmt(s.ratio)}`);
  soft(mm === 0, `${mm}/${pick.length} sampled rebuilt GLBs still have millimetre UVs (not rebaked yet; the viewer rescales them)`);
  soft(false, `sample: ${pick.length} GLBs, ${baked} baked`);
});
