import type * as THREE from 'three';

/**
 * Is this surface open (edges with one face: a leaf, a sheet, a cut shell), so its back can be seen?
 * Positions are welded (split normals/UVs don't count as edges), and a few stray holes are allowed.
 * Cached on the geometry (userData.open). Runs on the zfix worker for big meshes (zoff.ts).
 */
export function isOpen(g: THREE.BufferGeometry): boolean {
  if (g.userData.open !== undefined) return g.userData.open as boolean;
  const p = g.getAttribute('position') as THREE.BufferAttribute | undefined;
  const ix = g.index;
  const n = ix ? ix.count : (p?.count ?? 0);
  if (!p || n < 3) return (g.userData.open = true);
  // weld: one id per position (quantised to 0.1 mm, hashed: a rare collision only merges two points)
  const ids = new Int32Array(p.count);
  const at = new Map<number, number>();
  for (let v = 0; v < p.count; v++) {
    const k = (Math.imul(Math.round(p.getX(v) * 1e4), 73856093) ^ Math.imul(Math.round(p.getY(v) * 1e4), 19349663) ^ Math.imul(Math.round(p.getZ(v) * 1e4), 83492791)) >>> 0;
    let id = at.get(k);
    if (id === undefined) at.set(k, (id = at.size));
    ids[v] = id;
  }
  const edges = new Map<number, number>();
  const W = at.size + 1;
  for (let f = 0; f + 2 < n; f += 3) {
    const a = ids[ix ? ix.getX(f) : f], b = ids[ix ? ix.getX(f + 1) : f + 1], c = ids[ix ? ix.getX(f + 2) : f + 2];
    for (const [x, y] of [[a, b], [b, c], [c, a]]) {
      if (x === y) continue;
      const k = x < y ? x * W + y : y * W + x;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const c of edges.values()) if (c === 1) open++;
  return (g.userData.open = open > edges.size * 0.02);
}
