import * as THREE from 'three';
import type { Biome } from './biomes';
import type { ModelEntry } from './assets';
import type { RemoteEntry } from './remote';

export interface Rect {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export type LevelDesc =
  | { kind: 'city'; seed: number; biome: string; name: string; source?: ModelEntry; sourceScale?: number }
  | { kind: 'interior'; seed: number; name: string; style: string; floor: number; floors: number; biome: string; shop?: string }
  | { kind: 'nyc'; seed: number; name: string }
  | { kind: 'atrium' }
  | { kind: 'gallery'; theme: number; page: number; wing?: string };

export interface Portal {
  box: THREE.Box3;
  label: string;
  sub?: string;
  /** a level to enter, 'back' to climb out, or 'inspect' to open the info panel */
  target: LevelDesc | 'back' | 'inspect';
  inspect?: RemoteEntry;
  /** walk-through doorways trigger by themselves */
  auto?: boolean;
  /** where to stand (and face) when you come back through this portal */
  returnPos?: THREE.Vector3;
  returnYaw?: number;
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
  /** use the physical sky (and bake it into reflections) instead of a gradient */
  physicalSky?: boolean;
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
    if ((c as THREE.InstancedMesh).isInstancedMesh) (c as THREE.InstancedMesh).dispose();
  });
}
