/**
 * Cheap subsets of the real world for qa tests: one NYC chunk (instead of the 3x3 the level
 * constructor builds), one shop, one interior, one gallery. Cached per process so several
 * tests in a file share a build.
 */
import './env';
import * as THREE from 'three';
import { NycLevel } from '../src/nyc';
import type { Portal, Rect } from '../src/level';

export interface Chunk { group: THREE.Group; colliders: Rect[]; portals: Portal[]; ms: number }
const chunks = new Map<string, Chunk>();

/** one city block exactly as NycLevel builds it (block-local coordinates: origin at the block centre) */
export function nycChunk(seed = 1, cx = 0, cz = 0): Chunk {
  const k = `${seed},${cx},${cz}`;
  let c = chunks.get(k);
  if (!c) {
    // a bare NycLevel without its constructor (which would build 9 chunks, traffic and people)
    const lv = Object.create(NycLevel.prototype) as any;
    lv.seed = seed;
    lv.steam = [];
    lv.group = new THREE.Group();
    const t = performance.now();
    const ch = lv.block(cx, cz);
    c = { ...ch, ms: performance.now() - t };
    c!.group.updateMatrixWorld(true);
    chunks.set(k, c!);
  }
  return c!;
}

/** walk a tree collecting objects that pass `f` */
export function collect<T extends THREE.Object3D = THREE.Object3D>(root: THREE.Object3D, f: (o: THREE.Object3D) => boolean): T[] {
  const out: T[] = [];
  root.traverse((o) => { if (f(o)) out.push(o as T); });
  return out;
}
