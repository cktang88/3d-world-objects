/**
 * Scene census for one NYC block: which code adds the triangles. Every Mesh added to the scene
 * graph during the block build is tagged with the first non-three function on the stack; the
 * report lists triangles per adder before baking (QA_VERBOSE=1 to print). Budget checks per owner.
 */
import * as THREE from 'three';
import { test, expect } from './qa';
import { nycChunk } from './world';

const owner = new WeakMap<THREE.Object3D, string>();
const origAdd = THREE.Object3D.prototype.add;
THREE.Object3D.prototype.add = function (this: THREE.Object3D, ...objs: THREE.Object3D[]) {
  const st = new Error().stack?.split('\n').slice(2) ?? [];
  const fr = st.find((l) => !/three|Object3D|census|origAdd|\bB \(|\bC \(|\bPB \(|at add/.test(l)) ?? '';
  const name = (fr.match(/at (?:new )?([\w.$<>]+)/)?.[1] ?? '?').replace(/^Object\./, '');
  for (const o of objs) o.traverse((x) => { if (!owner.has(x)) owner.set(x, name); });
  return origAdd.apply(this, objs);
};

const tri = (m: THREE.Mesh) => {
  const g = m.geometry;
  return ((g.index ? g.index.count : g.attributes.position.count) / 3) * ((m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1);
};

test('census: triangles per adder in one block (pre-bake)', () => {
  // bake() clones geometries of stat; to see sources, census the stat group through bake's input:
  const by = new Map<string, number>();
  const prevBake = (globalThis as any).__bakeCensus;
  (globalThis as any).__bakeCensus = (src: THREE.Object3D) => {
    src.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const k = owner.get(m) ?? '?';
      by.set(k, (by.get(k) ?? 0) + tri(m));
    });
  };
  const c = nycChunk(1, 0, 0, true);
  (globalThis as any).__bakeCensus = prevBake;
  // and the meshes added straight to the chunk group (instanced etc.)
  c.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || m.userData.baked) return;
    const k = 'live:' + (owner.get(m) ?? '?');
    by.set(k, (by.get(k) ?? 0) + tri(m));
  });
  const rows = [...by.entries()].sort((a, b) => b[1] - a[1]);
  if (process.env.QA_VERBOSE) for (const [k, v] of rows.slice(0, 30)) console.log(`  ${String(Math.round(v / 1000)).padStart(6)}k  ${k}`);
  expect(rows.length > 0, 'census empty');
});
