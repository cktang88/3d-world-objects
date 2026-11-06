import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { vcMat } from '../nyc/common';

/**
 * Time-sliceable version of nyc/common bake(): merges every static mesh under `src` into one
 * mesh per material bucket (plain colours collapse into shared vertex-coloured materials;
 * textured, emissive and transparent materials keep their own). Yields every few meshes and
 * between bucket merges, so a driver can stop when its frame budget is spent.
 * Geometry stays indexed (cheaper vertex work than the non-indexed bake).
 */
export function* bakeSteps(src: THREE.Object3D, out: THREE.Group): Generator<void, void, unknown> {
  src.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  src.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && !Array.isArray(m.material)) meshes.push(m);
  });
  const buckets = new Map<string, { m: THREE.Material; geos: THREE.BufferGeometry[] }>();
  const col = new THREE.Color();
  let n = 0;
  for (const mesh of meshes) {
    const sm = mesh.material as THREE.MeshStandardMaterial;
    const plain = sm.isMeshStandardMaterial && !(sm as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial && !sm.map && !sm.userData.pbr && !sm.transparent && !sm.vertexColors && (sm.emissiveIntensity === 0 || sm.emissive.getHex() === 0);
    const keepColor = !!(sm.vertexColors && mesh.geometry.getAttribute('color'));
    let g = mesh.geometry.clone();
    g.applyMatrix4(mesh.matrixWorld);
    if (!g.index) {
      const count = g.getAttribute('position').count;
      const idx = new Uint32Array(count);
      for (let i = 0; i < count; i++) idx[i] = i;
      g.setIndex(new THREE.BufferAttribute(idx, 1));
    }
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k) && !(keepColor && k === 'color')) g.deleteAttribute(k);
    g.morphAttributes = {};
    const count = g.getAttribute('position').count;
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    let key: string, material: THREE.Material = mesh.material as THREE.Material;
    if (plain) {
      const rough = Math.round(sm.roughness * 3) / 3, metal = Math.round(sm.metalness * 2) / 2;
      material = vcMat(rough, metal);
      col.copy(sm.color);
      const c = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        c[i * 3] = col.r;
        c[i * 3 + 1] = col.g;
        c[i * 3 + 2] = col.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
      key = `vc|${rough}|${metal}`;
    } else key = `${material.uuid}|${keepColor}`;
    // bucket inputs must agree on attributes
    key += `|${Object.keys(g.attributes).sort().join(',')}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { m: material, geos: [] }));
    b.geos.push(g);
    if (++n % 120 === 0) yield;
  }
  yield;
  for (const b of buckets.values()) {
    const merged = mergeGeometries(b.geos, false);
    b.geos.forEach((g) => g.dispose());
    if (merged) {
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, b.m);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.userData.owned = true;
      out.add(mesh);
    }
    yield;
  }
}
