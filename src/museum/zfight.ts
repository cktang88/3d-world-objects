import * as THREE from 'three';

/**
 * Z-fighting (flicker): faces of different meshes in the same plane, facing the same way and
 * overlapping, cannot be ordered by the depth test and flicker as the camera moves. After the
 * method of autobattler-2's zfix.ts: bucket every triangle by its world plane, find overlapping
 * pairs from different meshes, and (fix) lift them apart along the normal in 2 mm steps, largest
 * face lowest, so stacks of three or more get distinct heights. Indexed geometry is handled by
 * moving the lifted triangles' vertices.
 *
 * Meshes whose material uses polygonOffset (decals: light pools) or is additive are left out:
 * they are drawn on top on purpose.
 */

export interface Tri {
  mesh: number;
  idx: [number, number, number];
  a: THREE.Vector3;
  b: THREE.Vector3;
  c: THREE.Vector3;
  n: THREE.Vector3;
  area: number;
  center: THREE.Vector3;
}

const LIFT = 0.002;
const _u = new THREE.Vector3(), _w = new THREE.Vector3();

function inside(P: THREE.Vector3, t: Tri) {
  const e = (x: THREE.Vector3, y: THREE.Vector3) => _u.subVectors(y, x).cross(_w.subVectors(P, x)).dot(t.n);
  const eps = 1e-8;
  return e(t.a, t.b) > eps && e(t.b, t.c) > eps && e(t.c, t.a) > eps;
}

function skip(m: THREE.Mesh) {
  const mat = m.material as THREE.Material;
  return Array.isArray(m.material) || !m.visible || mat.polygonOffset || mat.blending === THREE.AdditiveBlending || !m.geometry.getAttribute('position');
}

function collect(root: THREE.Object3D, filter?: (m: THREE.Mesh) => boolean) {
  root.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || skip(m) || (filter && !filter(m))) return;
    // hidden ancestors (a vestibule end wall while previewed...) do not draw
    for (let p: THREE.Object3D | null = m; p; p = p.parent) if (!p.visible) return;
    meshes.push(m);
  });
  const buckets = new Map<string, Tri[]>();
  meshes.forEach((m, mi) => {
    const g = m.geometry, p = g.getAttribute('position'), ix = g.index;
    const n = ix ? ix.count : p.count;
    const W = m.matrixWorld;
    for (let f = 0; f + 2 < n; f += 3) {
      const i0 = ix ? ix.getX(f) : f, i1 = ix ? ix.getX(f + 1) : f + 1, i2 = ix ? ix.getX(f + 2) : f + 2;
      const a = new THREE.Vector3().fromBufferAttribute(p, i0).applyMatrix4(W);
      const b = new THREE.Vector3().fromBufferAttribute(p, i1).applyMatrix4(W);
      const c = new THREE.Vector3().fromBufferAttribute(p, i2).applyMatrix4(W);
      const nn = _u.subVectors(b, a).cross(_w.subVectors(c, a)).clone();
      const area = nn.length() / 2;
      if (area < 1e-7) continue;
      nn.normalize();
      // faces lying on the floor facing down are never seen
      if (nn.y < -0.99 && Math.max(a.y, b.y, c.y) < 0.02) continue;
      const pl = nn.dot(a);
      const key = `${Math.round(nn.x * 150)},${Math.round(nn.y * 150)},${Math.round(nn.z * 150)},${Math.round(pl * 1500)}`;
      let l = buckets.get(key);
      if (!l) buckets.set(key, (l = []));
      l.push({ mesh: mi, idx: [i0, i1, i2], a, b, c, n: nn, area, center: a.clone().add(b).add(c).divideScalar(3) });
    }
  });
  return { meshes, buckets };
}

const overlap = (s: Tri, t: Tri) => inside(s.center, t) || inside(t.center, s);

/** coplanar, same-facing, overlapping triangle pairs from different meshes */
export function scanZFight(root: THREE.Object3D, filter?: (m: THREE.Mesh) => boolean) {
  const { meshes, buckets } = collect(root, filter);
  const pairs: { a: THREE.Mesh; b: THREE.Mesh; area: number; at: THREE.Vector3 }[] = [];
  for (const l of buckets.values()) {
    if (l.length < 2 || l.length > 4000) continue;
    for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) {
      const s = l[i], t = l[j];
      if (s.mesh === t.mesh || !overlap(s, t)) continue;
      pairs.push({ a: meshes[s.mesh], b: meshes[t.mesh], area: Math.min(s.area, t.area), at: s.center });
    }
  }
  return pairs;
}

/** lift overlapping coplanar faces of different meshes apart (repeats while anything moved, at most 4); returns triangles moved */
export function fixZFight(root: THREE.Object3D, filter?: (m: THREE.Mesh) => boolean, lift = LIFT): number {
  let moved = 0;
  for (let i = 0, n = 1; i < 4 && n; i++) moved += n = pass(root, filter, lift);
  return moved;
}

function pass(root: THREE.Object3D, filter: ((m: THREE.Mesh) => boolean) | undefined, step: number) {
  const { meshes, buckets } = collect(root, filter);
  const lift = new Map<Tri, number>();
  for (const l of buckets.values()) {
    if (l.length < 2 || l.length > 4000) continue;
    l.sort((s, t) => t.area - s.area);
    for (let j = 1; j < l.length; j++) {
      const t = l[j];
      let k = 0;
      for (let i = 0; i < j; i++) {
        const s = l[i];
        if (s.mesh === t.mesh || !overlap(s, t)) continue;
        k = Math.max(k, (lift.get(s) ?? 0) + 1);
      }
      if (k) lift.set(t, k);
    }
  }
  if (!lift.size) return 0;
  // per mesh: the largest lift asked of each vertex (shared vertices of indexed geometry move once)
  const perMesh = new Map<number, Map<number, { k: number; n: THREE.Vector3 }>>();
  for (const [t, k] of lift) {
    let vm = perMesh.get(t.mesh);
    if (!vm) perMesh.set(t.mesh, (vm = new Map()));
    for (const v of t.idx) {
      const cur = vm.get(v);
      if (!cur || cur.k < k) vm.set(v, { k, n: t.n });
    }
  }
  for (const [mi, vm] of perMesh) {
    const m = meshes[mi];
    const p = m.geometry.getAttribute('position') as THREE.BufferAttribute;
    const inv = m.matrixWorld.clone().invert();
    const w = new THREE.Vector3();
    for (const [v, { k, n }] of vm) {
      w.fromBufferAttribute(p, v).applyMatrix4(m.matrixWorld).addScaledVector(n, step * Math.min(k, 4)).applyMatrix4(inv);
      p.setXYZ(v, w.x, w.y, w.z);
    }
    p.needsUpdate = true;
    m.geometry.computeBoundingSphere();
  }
  return lift.size;
}
