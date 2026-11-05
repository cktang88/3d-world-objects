import * as THREE from 'three';
import type { Biome } from './biomes';
import type { ModelEntry } from './assets';

export interface Rect {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export type LevelDesc =
  | { kind: 'city'; seed: number; biome: string; name: string; source?: ModelEntry; sourceScale?: number }
  | { kind: 'interior'; seed: number; name: string; style: string; floor: number; floors: number; biome: string };

export interface Portal {
  box: THREE.Box3;
  label: string;
  sub?: string;
  /** a level to enter, or 'back' to climb out */
  target: LevelDesc | 'back';
  /** relative size of the thing being entered (for the scale counter) */
  shrink?: number;
}

export interface Env {
  skyTop: string;
  skyBottom: string;
  stars: boolean;
  fog: string | null;
  fogNear: number;
  fogFar: number;
  sun: { color: string; intensity: number; elev: number; azim: number } | null;
  hemi: { sky: string; ground: string; intensity: number };
  ambient: number;
  envIntensity: number;
  exposure: number;
}

export interface Level {
  name: string;
  group: THREE.Group;
  spawn: { pos: THREE.Vector3; yaw: number };
  env: Env;
  biome?: Biome;
  colliders(near: THREE.Vector3): Rect[];
  portals(): Portal[];
  update(dt: number, player: THREE.Vector3, time: number): void;
  dispose(): void;
}

export function rect(cx: number, cz: number, w: number, d: number): Rect {
  return { minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2 };
}

export function overlaps(a: Rect, b: Rect, pad = 0): boolean {
  return a.minX < b.maxX + pad && a.maxX > b.minX - pad && a.minZ < b.maxZ + pad && a.maxZ > b.minZ - pad;
}

export function disposeTree(o: THREE.Object3D) {
  o.traverse((c) => {
    c.userData.disposed = true;
    const m = c as THREE.Mesh;
    // Only dispose geometry we own (procedural); model geometries are shared from the loader cache.
    if (m.isMesh && m.userData.owned) m.geometry.dispose();
  });
}
