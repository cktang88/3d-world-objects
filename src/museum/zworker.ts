import * as THREE from 'three';
import { fixZFight } from './zfight';
import type { ZJob, ZReply, ZGeo } from './zoff';

/**
 * The exhibit flicker fix off the main thread (zoff.ts): the exhibit's meshes come in as typed arrays
 * (world matrices, every attribute, index, groups), are rebuilt here, fixed by the shared zfix, and
 * the geometries it changed go back, transferred.
 */
const pack = (g: THREE.BufferGeometry): ZGeo => {
  const attrs: ZGeo['attrs'] = {};
  for (const [n, a] of Object.entries(g.attributes)) {
    const b = a as THREE.BufferAttribute;
    attrs[n] = { array: b.array as ZGeo['attrs'][string]['array'], itemSize: b.itemSize, normalized: b.normalized };
  }
  return { attrs, index: (g.index?.array as Uint16Array | Uint32Array | undefined) ?? null, groups: g.groups.map((x) => ({ ...x })) };
};

const scope = self as unknown as { onmessage: (e: MessageEvent<ZJob>) => void; postMessage: (m: ZReply, t: Transferable[]) => void };
scope.onmessage = (e: MessageEvent<ZJob>) => {
  const { id, lift, meshes } = e.data;
  const t0 = performance.now();
  const root = new THREE.Group();
  const geos: THREE.BufferGeometry[] = [];
  const objs: THREE.Mesh[] = [];
  for (const m of meshes) {
    const g = new THREE.BufferGeometry();
    for (const [n, a] of Object.entries(m.geo.attrs)) g.setAttribute(n, new THREE.BufferAttribute(a.array, a.itemSize, a.normalized));
    if (m.geo.index) g.setIndex(new THREE.BufferAttribute(m.geo.index, 1));
    for (const gr of m.geo.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
    const mat = new THREE.MeshBasicMaterial({ polygonOffset: m.offset, blending: m.additive ? THREE.AdditiveBlending : THREE.NormalBlending });
    const o = new THREE.Mesh(g, mat);
    o.matrixAutoUpdate = false;
    o.matrix.fromArray(m.matrix);
    root.add(o);
    geos.push(g);
    objs.push(o);
  }
  let moved = 0;
  try {
    moved = fixZFight(root, undefined, lift, 'worker');
  } catch {
    moved = 0;
  }
  const changed: ZReply['changed'] = [];
  const transfer: Transferable[] = [];
  objs.forEach((o, i) => {
    if (o.geometry === geos[i]) return;
    const geo = pack(o.geometry);
    changed.push({ i, geo });
    for (const a of Object.values(geo.attrs)) transfer.push(a.array.buffer);
    if (geo.index) transfer.push(geo.index.buffer);
  });
  const reply: ZReply = { id, moved, ms: performance.now() - t0, changed };
  scope.postMessage(reply, transfer);
};
