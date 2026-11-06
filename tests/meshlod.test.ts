/**
 * Mesh simplification / LOD quality (see .claude/skills/mesh-simplification/SKILL.md):
 *  - the simplifier core on a synthetic bumpy mesh: LOD chain ratios, error accounting, visible error
 *  - every fleet car's LOD files: triangle budgets and ratios, shape kept (14-view silhouette/depth vs the
 *    near LOD), normals/uvs present where shading and textures need them
 */
import { readFileSync } from 'fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { test, expect, between, fmt } from './qa';
import { simplifierReady, lodChain, viewError, surfaceDistance, switchDistance, simplifyMesh, uvSeamLock } from '../src/meshlod-core';
import { FLEET } from '../src/nyc/vehicleFleet';
import * as THREE from 'three';
import { addLods, lodTris, ScreenLOD } from '../src/meshlod';

function bumpy(n = 120) {
  const P: number[] = [], UV: number[] = [], I: number[] = [];
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) {
      const th = (j / n) * Math.PI, ph = ((i % n) / n) * Math.PI * 2; // u=1 reuses u=0 positions exactly: a uv seam
      const d = 1 + 0.05 * Math.sin(5 * th) * Math.cos(3 * ph);
      P.push(Math.sin(th) * Math.cos(ph) * d, Math.cos(th) * d, Math.sin(th) * Math.sin(ph) * d);
      UV.push(i / n, j / n);
    }
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, e = c + 1;
      I.push(a, c, b, b, c, e);
    }
  return { position: new Float32Array(P), uv: new Float32Array(UV), index: new Uint32Array(I) };
}

test('simplifier core: LOD chain 100/25/6 % with growing error, small visible error, UV seam kept', async () => {
  await simplifierReady;
  const m = bumpy();
  const full = m.index.length / 3;
  const chain = lodChain(m, [0.25, 0.06]);
  expect(chain.length === 3, `chain has ${chain.length} levels`);
  between(chain[1].tris / full, 0.2, 0.3, 'LOD1 ratio');
  between(chain[2].tris / full, 0.04, 0.08, 'LOD2 ratio');
  expect(chain[1].error > 0 && chain[2].error > chain[1].error, `errors grow: ${chain.map((l) => fmt(l.error))}`);
  for (const k of [1, 2]) {
    const v = viewError(m.position, m.index, m.position, chain[k].index, 128);
    // a 2 m object: visible depth error under a few cm, outline within 1.5 %
    expect(v.silhouette < 0.015, `LOD${k} silhouette mismatch ${fmt(v.silhouette)}`);
    expect(v.depthP95 < 0.04, `LOD${k} visible depth p95 ${fmt(v.depthP95)} m`);
    const d = surfaceDistance(m.position, m.index, m.position, chain[k].index, 1500);
    expect(d.max <= chain[k].error * 3 + 0.01, `LOD${k} Hausdorff ${fmt(d.max)} vs reported error ${fmt(chain[k].error)}`);
  }
  // the u=0/u=1 seam: positions shared by vertices with different uvs are protected in permissive mode
  const lock = uvSeamLock(m)!;
  expect(lock.reduce((s, v) => s + (v ? 1 : 0), 0) >= 2 * 120, 'uv seam vertices are locked');
  const perm = simplifyMesh(m, { targetTris: full * 0.1, error: 0.05, permissive: true });
  expect(perm.index.length / 3 <= full * 0.12, `permissive simplify reaches its target (${perm.index.length / 3})`);
  // screen-space switching: 1 px at 1080p/60° for a 1 cm error is ~9.4 m away
  between(switchDistance(0.01, 60, 1080, 1), 9, 10, 'switch distance for 1 cm at 1 px');
});

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
async function glb(file: string) {
  const doc = await io.readBinary(new Uint8Array(readFileSync(`public/assets/vehicles/${file}`)));
  const P: number[] = [], I: number[] = [];
  let base = 0;
  const el: number[] = [];
  const prims: { sems: string[]; textured: boolean }[] = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const w = node.getWorldMatrix();
    for (const p of mesh.listPrimitives()) {
      const pos = p.getAttribute('POSITION')!;
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, el);
        P.push(...[0, 1, 2].map((r) => w[r] * el[0] + w[4 + r] * el[1] + w[8 + r] * el[2] + w[12 + r]));
      }
      const ix = p.getIndices()!.getArray()!;
      for (let i = 0; i < ix.length; i++) I.push(ix[i] + base);
      base += pos.getCount();
      prims.push({ sems: p.listSemantics(), textured: !!p.getMaterial()?.getBaseColorTexture() });
    }
  }
  return { pos: new Float32Array(P), idx: new Uint32Array(I), tris: I.length / 3, prims };
}

test('vehicle LODs: near <=16k tris (accord19 <=32k), mid/far ratios, shape kept vs near, normals + uvs present', async () => {
  await MeshoptDecoder.ready;
  for (const id of Object.keys(FLEET)) {
    let near;
    try {
      near = await glb(`${id}.glb`);
    } catch {
      continue; // models without files (buses/trucks are procedural)
    }
    const mid = await glb(`${id}_lod1.glb`), far = await glb(`${id}_lod2.glb`);
    expect(near.tris <= (id === 'accord19' ? 32000 : 16000), `${id} near LOD ${near.tris} tris`);
    expect(mid.tris <= near.tris * 0.5 && mid.tris <= 6000, `${id} mid LOD ${mid.tris} tris (near ${near.tris})`);
    expect(far.tris <= mid.tris && far.tris <= 2600, `${id} far LOD ${far.tris} tris (mid ${mid.tris})`);
    // measured: mid silhouette 0.5-7 %, far 1-15 % against the near LOD (the old LODs reached 21 %)
    const vm = viewError(near.pos, near.idx, mid.pos, mid.idx, 128), vf = viewError(near.pos, near.idx, far.pos, far.idx, 128);
    expect(vm.silhouette < 0.09, `${id} mid silhouette mismatch ${fmt(vm.silhouette)}`);
    expect(vf.silhouette < 0.18, `${id} far silhouette mismatch ${fmt(vf.silhouette)}`);
    // shading needs normals in the near LOD; textured parts keep their uvs
    for (const p of near.prims) {
      expect(p.sems.includes('NORMAL'), `${id} near LOD primitive without normals`);
      if (p.textured) expect(p.sems.includes('TEXCOORD_0'), `${id} textured near primitive lost its uvs`);
    }
  }
});

test('runtime LODs (originals/scans): heavy mesh -> ScreenLOD 100/25/6 %, shared vertex buffers, switch by screen error, clone keeps it', async () => {
  const m = bumpy(160); // 51k tris, uvs
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(m.uv, 2));
  g.setIndex(new THREE.BufferAttribute(m.index, 1));
  g.computeVertexNormals();
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial());
  mesh.position.set(1, 2, 3);
  root.add(mesh);
  const light = new THREE.Mesh(new THREE.BoxGeometry(), mesh.material);
  root.add(light);
  const n = await addLods(root, { minTris: 40_000 });
  expect(n === 1, `one heavy mesh gets LODs (${n})`);
  const lod = root.children.find((c) => c instanceof ScreenLOD) as ScreenLOD;
  expect(!!lod && lod.levels.length === 3, `ScreenLOD with 3 levels (${lod?.levels.length})`);
  expect(lod.position.equals(new THREE.Vector3(1, 2, 3)), 'LOD takes the mesh transform');
  const full = m.index.length / 3;
  const tris = lod.levels.map((l) => ((l.object as THREE.Mesh).geometry.index!.count / 3) / full);
  between(tris[1], 0.2, 0.3, 'level 1 ratio');
  between(tris[2], 0.04, 0.08, 'level 2 ratio');
  expect((lod.levels[1].object as THREE.Mesh).geometry.getAttribute('position') === g.getAttribute('position'), 'levels share the vertex buffers');
  expect(lodTris(root) === full + 12, `budget counts the finest level only (${lodTris(root)})`);
  // a 2 m object, 1080 px, 60 deg: near shows the original, far the coarsest
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  root.updateMatrixWorld(true);
  const at = (d: number) => {
    cam.position.set(1, 2, 3 + d);
    cam.updateMatrixWorld();
    lod.update(cam);
    return lod.getCurrentLevel();
  };
  expect(at(1.0) === 0, `level 0 at the surface (errors ${lod.levels.map((l) => fmt(l.distance))})`);
  expect(at(400) === 2, `coarsest level far away (got ${at(400)})`);
  const mid = [5, 10, 20, 40, 80, 160].map(at);
  expect(mid.every((v, i) => i === 0 || v >= mid[i - 1]), `levels only coarsen with distance: ${mid}`);
  expect(lod.levels.filter((l) => l.object.visible).length === 1, 'exactly one level visible');
  const copy = root.clone(true);
  const lc = copy.children.find((c) => c instanceof ScreenLOD) as ScreenLOD;
  expect(!!lc && lc.levels.length === 3 && lc.levels[2].distance === lod.levels[2].distance, 'clone(true) keeps the chain and its errors');
});
