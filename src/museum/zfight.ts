import * as THREE from 'three';
import { scanZFight as scan, fixZFight as fix } from '../zfix';

/**
 * Museum z-fight helpers: thin wrappers over the shared implementation in src/zfix.ts (one scanner/fixer for
 * the city, interiors and museum). Same signatures as before: a mesh filter and a per-call lift (m). Pairs
 * inside one mesh (duplicated triangles) are not counted here, as before. polygonOffset decals and additive
 * glows are left out, and faces lying on the floor facing down are ignored (zfix defaults).
 */
// coplanar = within ~1 mm (res 0.5 mm): below the museum's 2 mm lift, so lifted faces stop counting
// overlaps must be over 1.1 cm in every direction: the 1 cm floor-slab edges along the walls (unowned, not
// movable here) are below what reads as flicker; the earlier centroid test did not see them either
const FINE = { sameMesh: false, minArea: 1e-6, minOverlap: 0.011, res: 0.0005 };

export function scanZFight(root: THREE.Object3D, filter?: (m: THREE.Mesh) => boolean) {
  const s = scan(root, { ...FINE, filter, keepPairs: true });
  return s.list.map((p) => ({ a: p.objA as THREE.Mesh, b: p.objB as THREE.Mesh, area: p.area, at: new THREE.Vector3(...p.at) }));
}

/** lift overlapping coplanar faces of different meshes apart (at most 4 passes); returns triangles moved */
export function fixZFight(root: THREE.Object3D, filter?: (m: THREE.Mesh) => boolean, lift = 0.002, kind = 'fix'): number {
  // every mesh is seen, only the filtered ones move
  const r = fix(root, { ...FINE, movable: filter as ((o: THREE.Object3D) => boolean) | undefined, step: lift });
  zfixStats.push({ kind, ms: r.ms, moved: r.moved });
  if (zfixStats.length > 400) zfixStats.shift();
  return r.moved;
}

/** timings of the fixer's calls by kind (window.__zfix in the browser) */
export const zfixStats: { kind: string; ms: number; moved: number }[] = [];
if (typeof window !== 'undefined') (window as unknown as { __zfix: unknown }).__zfix = zfixStats;
